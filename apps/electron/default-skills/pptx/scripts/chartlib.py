# chartlib.py —— Profer 高级图表封装库
# 用 python-pptx 全量封装，解决 pptxgenjs 做不了的高级图表：组合图 / 双 Y 轴 / 84 种图表类型 / 精细美化。
# 统一接口，Agent 传数据 + 选类型 + 选配色即可，不碰底层 XML。
#
# 用法：
#   from chartlib import add_chart, CHARTS
#   from pptx import Presentation
#   from pptx.util import Inches
#
#   prs = Presentation(); prs.slide_width = Inches(10); prs.slide_height = Inches(5.625)
#   slide = prs.slides.add_slide(prs.slide_layouts[6])  # blank
#   add_chart(slide, 'COLUMN_CLUSTERED', {
#       'categories': ['Q1','Q2','Q3','Q4'],
#       'series': [{'name':'收入','values':[10,15,13,18]}, {'name':'成本','values':[6,8,7,9]}],
#   }, x=0.8, y=1.5, w=8.4, h=3.5, palette='midnight', title='季度营收')
#   prs.save('out.pptx')
#
# 组合图（柱+线双轴）：
#   add_chart(slide, 'COLUMN_LINE', {
#       'categories': [...],
#       'series': [{'name':'柱','values':[...],'chart_type':'COLUMN_CLUSTERED'},
#                  {'name':'线','values':[...],'chart_type':'LINE','secondary_axis':True}],
#   }, ...)

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.chart.data import CategoryChartData, ChartData
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION, XL_LABEL_POSITION, XL_TICK_MARK
from pptx.dml.color import RGBColor
from pptx.oxml.ns import qn
import copy

# ---- 84 种图表类型简写 → XL_CHART_TYPE 映射 ----
# 用户可用简写（如 'COLUMN_CLUSTERED'）或完整枚举，这里提供别名表
CHART_ALIASES = {
    'BAR': XL_CHART_TYPE.COLUMN_CLUSTERED,
    'COLUMN': XL_CHART_TYPE.COLUMN_CLUSTERED,
    'BAR_STACKED': XL_CHART_TYPE.COLUMN_STACKED,
    'LINE': XL_CHART_TYPE.LINE,
    'LINE_MARKERS': XL_CHART_TYPE.LINE_MARKERS,
    'PIE': XL_CHART_TYPE.PIE,
    'PIE_EXPLODED': XL_CHART_TYPE.PIE_EXPLODED,
    'DOUGHNUT': XL_CHART_TYPE.DOUGHNUT,
    'AREA': XL_CHART_TYPE.AREA,
    'RADAR': XL_CHART_TYPE.RADAR,
    'SCATTER': XL_CHART_TYPE.XY_SCATTER,
    'BUBBLE': XL_CHART_TYPE.BUBBLE,
}

# 可从字符串名解析到 XL_CHART_TYPE
def _resolve_chart_type(name):
    if isinstance(name, XL_CHART_TYPE):
        return name
    if name in CHART_ALIASES:
        return CHART_ALIASES[name]
    # 直接查枚举成员名
    if hasattr(XL_CHART_TYPE, name):
        return getattr(XL_CHART_TYPE, name)
    raise ValueError(f"未知图表类型: {name}")

# ---- 10 套配色方案（与设计系统 profer-ppt-design-system.md 对齐）----
PALETTES = {
    'midnight': ['1E2761', '3A4A9C', '5A6BC0', 'CADCFC', 'F9C74F', '7E8CC9'],
    'forest':   ['2C5F2D', '97BC62', '4A7C50', '8FBF6F', 'E8F0E0', '6B8E5A'],
    'coral':    ['F96167', 'F9E795', '2F3C7E', 'F9B5A2', 'E78A5E', '7A8BE0'],
    'terracotta':['B85042', 'E7E8D1', 'A7BEAE', 'D98A6B', 'C9705A', '8FAF9A'],
    'ocean':    ['065A82', '1C7293', '21295C', '3D9BB0', '4FB0C6', '2A4A6E'],
    'charcoal': ['36454F', 'F2F2F2', 'E63946', '5A6B76', '7E8E98', 'B0BCC4'],
    'teal':     ['028090', '00A896', '02C39A', '4FD1C5', 'F4A261', '38B2AC'],
    'berry':    ['6D2E46', 'A26769', 'ECE2D0', 'B08086', '8F4A5C', 'C99A9E'],
    'sage':     ['84B59F', '69A297', '50808E', '9CC4B5', '7FB0A3', '6E93A0'],
    'cherry':   ['990011', 'FCF6F5', '2F3C7E', 'B33B4A', 'C6525F', '7A8BE0'],
}

def _rgb(hexstr):
    h = hexstr.lstrip('#')
    if len(h) == 3:
        h = ''.join(c + c for c in h)
    return RGBColor(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))

def _palette(name):
    return PALETTES.get(name, PALETTES['midnight'])


def add_chart(slide, chart_type, data, x, y, w, h, palette='midnight', title=None,
              show_legend=None, show_value=False, value_font_size=10,
              line_smooth=False, val_gridline=True, cat_gridline=False,
              rounded_corners=False, **extra):
    """在 slide 上添加一个图表（统一入口）。

    参数：
      chart_type: 字符串或 XL_CHART_TYPE。组合图传 'COLUMN_LINE' 等复合类型（见下方 combo 逻辑）。
      data: dict {
          'categories': [...],
          'series': [ {'name','values'[, 'chart_type', 'secondary_axis']}, ... ]
      }
      x/y/w/h: 英寸数字。
      palette: 配色方案名（见 PALETTES）。
      title: 图表标题；None 则不显示。
      show_legend: 是否显示图例（None=自动：多 series 显示，单 series 隐藏）。
      show_value: 是否显示数据标签。
      val_gridline / cat_gridline: 是否显示数值/类别网格线。
      rounded_corners: 图表区圆角。
    返回图表对象（可继续 .value_axis 等深入定制）。
    """
    colors = _palette(palette)
    return _build_chart(slide, chart_type, data, x, y, w, h, colors, title,
                        show_legend, show_value, value_font_size, line_smooth,
                        val_gridline, cat_gridline, rounded_corners)


def _build_chart(slide, chart_type, data, x, y, w, h, colors, title,
                 show_legend, show_value, value_font_size, line_smooth,
                 val_gridline, cat_gridline, rounded_corners):
    categories = data.get('categories', [])
    series_list = data.get('series', [])

    # 判断是否组合图（任一 series 带 chart_type 或 secondary_axis）
    is_combo = any('chart_type' in s or 'secondary_axis' in s for s in series_list)

    # 组合图实现：python-pptx 原生不直接支持 combo，需在 chart XML 上给 series 换类型。
    # 做法：先按主类型建 chart，再逐 series 改其 <c:chart> 类型 + 是否需要次坐标轴。
    main_type = _resolve_chart_type(chart_type) if not is_combo else \
        _resolve_chart_type(series_list[0].get('chart_type', chart_type))

    cd = CategoryChartData()
    cd.categories = categories
    for s in series_list:
        cd.add_series(s['name'], list(s['values']))

    chart_frame = slide.shapes.add_chart(main_type, Inches(x), Inches(y), Inches(w), Inches(h), cd)
    chart = chart_frame.chart

    # ---- 配色（先做，此时 chart 结构仍是 python-pptx 标准单一容器） ----
    _apply_series_colors(chart, colors)

    # ---- 标题 ----
    if title:
        chart.has_title = True
        chart.chart_title.text_frame.text = title
    else:
        chart.has_title = False

    # ---- 图例 ----
    if show_legend is None:
        chart.has_legend = len(series_list) > 1
    else:
        chart.has_legend = show_legend
    if chart.has_legend:
        chart.legend.position = XL_LEGEND_POSITION.BOTTOM
        chart.legend.include_in_layout = False

    # ---- 数值轴网格线 ----
    try:
        va = chart.value_axis
        va.has_major_gridlines = val_gridline
        va.has_minor_gridlines = False
        if val_gridline:
            _set_gridline_color(va.major_gridlines, 'E2E8F0')
        _set_axis_text_color(va, '666666')
    except Exception:
        pass

    try:
        ca = chart.category_axis
        ca.has_major_gridlines = cat_gridline
        ca.has_minor_gridlines = False
        _set_axis_text_color(ca, '666666')
    except Exception:
        pass

    # ---- 数据标签 ----
    if show_value:
        _show_data_labels(chart, value_font_size, colors)

    # ---- 折线平滑 ----
    if line_smooth:
        _set_line_smooth(chart)

    # ---- 圆角图表区 ----
    if rounded_corners:
        _set_rounded_corners(chart)

    # ---- 组合图拆分：必须放在所有对象模型操作之后，否则对象模型会在拆分后误写 ----
    if is_combo:
        _apply_combo_series_types(chart, series_list, chart_type, main_type)
        _setup_secondary_axis(chart, series_list)

    # ⚠️ 不要修正 axId 符号：python-pptx 的负数 axId 是合法的（PowerPoint 能打开），
    # 转换反而会破坏 axId/crossAx 的成对引用。保持 python-pptx 原样。

    return chart


def _fix_all_axid_signs(chart):
    """[已弃用] 修正 axId 符号。
    实测证明：python-pptx 生成的负数 axId 在 PowerPoint 中能正常打开，
    强制转 unsigned 反而破坏文件（axId 与 crossAx 成对引用被打断）。保留此函数仅为文档记录，不要调用。"""
    from pptx.oxml.ns import qn
    for tag in ('c:axId', 'c:crossAx'):
        for el in chart._chartSpace.iter(qn(tag)):
            val = el.get('val')
            if val is not None:
                n = int(val)
                if n < 0:
                    el.set('val', str(n & 0xFFFFFFFF))


def _apply_combo_series_types(chart, series_list, chart_type, main_type):
    """把各个 series 设置成指定类型（组合图核心）。"""
    series_objs = chart.series
    for i, s in enumerate(series_list):
        target = s.get('chart_type')
        if target is None:
            continue
        t = _resolve_chart_type(target)
        _set_series_chart_type(series_objs[i], t)


def _set_series_chart_type(series, chart_type):
    """修改单个 series 的图表类型（组合图核心）。
    通过标准的 OOXML 做法：把该 <c:ser> 移入一个新的 chart 容器。<c:barChart>/<c:lineChart> 等。"""
    from lxml import etree
    ser = series._element  # <c:ser>
    _inject_combo_type(ser, chart_type)


def _inject_combo_type(ser, chart_type):
    """按 OOXML 规范，为组合图 series 注入类型。
    标准做法：在 plotArea 下新建目标类型容器（<c:lineChart> 等），把该 <c:ser> 复制进去，
    并给每个容器正确的子元素（grouping + 2 个 axId）。"""
    from lxml import etree
    from pptx.oxml.ns import qn

    type_tags = {
        'COLUMN_CLUSTERED': 'barChart',
        'COLUMN_STACKED': 'barChart',
        'LINE': 'lineChart',
        'LINE_MARKERS': 'lineChart',
        'AREA': 'areaChart',
        'PIE': 'pieChart',
        'DOUGHNUT': 'doughnutChart',
        'XY_SCATTER': 'scatterChart',
        'RADAR': 'radarChart',
        'BUBBLE': 'bubbleChart',
    }
    key = _chart_type_key(chart_type)
    if key is None:
        return
    tag = type_tags.get(key)
    if tag is None:
        return

    parent_container = ser.getparent()
    plot_area = parent_container.getparent()
    if plot_area is None:
        return

    # 若已在正确类型容器，跳过
    if parent_container.tag == qn('c:' + tag):
        return

    # 新建或复用目标容器
    target = None
    for child in plot_area:
        if child.tag == qn('c:' + tag):
            target = child; break
    if target is None:
        target = plot_area.makeelement(qn('c:' + tag), {})
        if tag == 'barChart':
            _append_el(target, parent_container, 'barDir')
            _append_el(target, parent_container, 'grouping')
            _append_el(target, parent_container, 'gapWidth')
            _append_el(target, parent_container, 'overlap')
        elif tag == 'lineChart':
            g = target.makeelement(qn('c:grouping'), {})
            g.set('val', 'standard')
            target.append(g)
        # 🔴 关键：chart 容器必须插在所有轴(valAx/catAx)之前，不能 append 到末尾
        _insert_before_axes(plot_area, target)

    # 把 ser 复制进目标容器（ser 必须在 axId 之前）
    new_ser = etree.fromstring(etree.tostring(ser))
    target.append(new_ser)
    parent_container.remove(ser)

    # axId 必须在 ser 之后（schema 顺序：... ser* → dLbls → ... → axId×2）
    # 注意：不要做符号修正，保持 python-pptx 原始负数 axId（PowerPoint 可正常打开）
    if len(target.findall(qn('c:axId'))) < 2:
        for axid in parent_container.findall(qn('c:axId')):
            target.append(etree.fromstring(etree.tostring(axid)))

    # ⚠️ do NOT call _renumber_orders：c:order 是跨整个 chart 唯一的系列序号，
    # 拆到不同容器后必须保持原始值(0,1,2...)，重编会造成跨容器 order 冲突，破坏文件。


def _insert_before_axes(plot_area, element):
    """把 chart 容器插到 plotArea 中第一个轴元素之前（OOXML：chart 容器必须在所有轴之前）。"""
    from pptx.oxml.ns import qn
    axis_tags = (qn('c:valAx'), qn('c:catAx'), qn('c:dateAx'), qn('c:serAx'),
                 qn('c:dTable'), qn('c:spPr'), qn('c:extLst'))
    for i, child in enumerate(plot_area):
        if child.tag in axis_tags:
            plot_area.insert(i, element)
            return
    plot_area.append(element)  # 没有轴则直接 append


def _fix_axid_sign(axid_el):
    """把 axId 的 val 从可能的有符号负数转成 unsigned int 正数（xs:unsignedInt）。"""
    val = axid_el.get('val')
    if val is not None:
        n = int(val)
        if n < 0:
            axid_el.set('val', str(n & 0xFFFFFFFF))


def _append_el(target, src_container, tag):
    """从源容器复制一个子元素到目标（若存在）。"""
    from lxml import etree
    from pptx.oxml.ns import qn
    el = src_container.find(qn('c:' + tag))
    if el is not None:
        target.append(etree.fromstring(etree.tostring(el)))


def _renumber_orders(plot_area):
    """重新编号各 chart 容器内 ser 的 order，保证连续。"""
    from pptx.oxml.ns import qn
    for container in plot_area:
        if container.tag in (qn('c:catAx'), qn('c:valAx'), qn('c:serAx'), qn('c:dateAx')):
            continue
        sers = container.findall(qn('c:ser'))
        for i, s in enumerate(sers):
            order = s.find(qn('c:order'))
            if order is not None:
                order.set('val', str(i))


def _setup_secondary_axis(chart, series_list):
    """为组合图中标记了 secondary_axis 的 series 建立次坐标轴（双 Y 轴）。
    在 plotArea 添加第二个 <c:valAx>，并让对应容器引用新 axId。"""
    from pptx.oxml.ns import qn
    from lxml import etree
    import random

    if not any(s.get('secondary_axis') for s in series_list):
        return
    plot_area = chart._chartSpace.find('.//' + qn('c:plotArea'))
    if plot_area is None:
        return
    existing_val_axes = plot_area.findall(qn('c:valAx'))
    if len(existing_val_axes) >= 2:
        return

    sec_axid = random.randint(100000, 999999)
    if existing_val_axes:
        new_ax = etree.fromstring(etree.tostring(existing_val_axes[0]))
        axid_el = new_ax.find(qn('c:axId'))
        if axid_el is not None:
            axid_el.set('val', str(sec_axid))
        pos = new_ax.find(qn('c:axPos'))
        if pos is not None:
            pos.set('val', 'r')
        for gl in new_ax.findall(qn('c:majorGridlines')):
            new_ax.remove(gl)
        for gl in new_ax.findall(qn('c:minorGridlines')):
            new_ax.remove(gl)
        plot_area.append(new_ax)

    _bind_secondary_axis_to_series(chart, series_list, sec_axid)


def _bind_secondary_axis_to_series(chart, series_list, sec_axid):
    from pptx.oxml.ns import qn
    plot_area = chart._chartSpace.find('.//' + qn('c:plotArea'))
    flags = [bool(s.get('secondary_axis')) for s in series_list]
    for container in list(plot_area):
        if container.tag in (qn('c:catAx'), qn('c:valAx'), qn('c:serAx'), qn('c:dateAx')):
            continue
        sers = container.findall(qn('c:ser'))
        if not sers:
            continue
        for s in sers:
            # 用 c:idx（系列全局索引，renumber 不会改变化）判断是否次轴
            idx_el = s.find(qn('c:idx'))
            idx = int(idx_el.get('val')) if idx_el is not None else 0
            if idx < len(flags) and flags[idx]:
                axids = container.findall(qn('c:axId'))
                if len(axids) >= 2:
                    axids[1].set('val', str(sec_axid))
                break


def _chart_type_key(t):
    for name in ['COLUMN_CLUSTERED','COLUMN_STACKED','LINE','LINE_MARKERS','AREA','PIE','DOUGHNUT','XY_SCATTER','RADAR','BUBBLE']:
        if getattr(XL_CHART_TYPE, name, None) == t:
            return name
    return None


def _apply_series_colors(chart, colors):
    """给每个 series 上色。"""
    try:
        series = chart.series
        for i, s in enumerate(series):
            color = colors[i % len(colors)]
            s.format.fill.solid()
            s.format.fill.fore_color.rgb = _rgb(color)
            # 折线还要设线色
            s.format.line.color.rgb = _rgb(color)
    except Exception:
        pass


def _set_gridline_color(gridlines, hexstr):
    try:
        gridlines.format.line.color.rgb = _rgb(hexstr)
    except Exception:
        pass


def _set_axis_text_color(axis, hexstr):
    try:
        axis.tick_labels.font.color.rgb = _rgb(hexstr)
        axis.tick_labels.font.size = Pt(9)
    except Exception:
        pass


def _show_data_labels(chart, font_size, colors):
    try:
        plot = chart.plots[0]
        plot.has_data_labels = True
        dl = plot.data_labels
        dl.font.size = Pt(font_size)
        dl.font.color.rgb = _rgb('333333')
    except Exception:
        pass


def _set_line_smooth(chart):
    try:
        for s in chart.series:
            # smooth 属性在 lineChart 下：<c:smooth val="1"/>
            ser = s._element
            smooth = ser.find(qn('c:smooth'))
            if smooth is None:
                smooth = ser.makeelement(qn('c:smooth'), {})
                ser.append(smooth)
            smooth.set('val', '1')
    except Exception:
        pass


def _set_rounded_corners(chart):
    try:
        chart_space = chart._chartSpace
        rounded = chart_space.find(qn('c:roundedCorners'))
        if rounded is None:
            from lxml import etree
            rounded = chart_space.makeelement(qn('c:roundedCorners'), {})
            chart_space.insert(0, rounded)
        rounded.set('val', '1')
    except Exception:
        pass


# ---- 便捷：创建空白演示 ----
def new_presentation(w=10, h=5.625):
    prs = Presentation()
    prs.slide_width = Inches(w)
    prs.slide_height = Inches(h)
    return prs


def add_blank_slide(prs):
    return prs.slides.add_slide(prs.slide_layouts[6])  # blank layout


if __name__ == '__main__':
    # 自测：快速生成一张含组合图的 pptx
    prs = new_presentation()
    slide = add_blank_slide(prs)
    add_chart(slide, 'COLUMN_LINE', {
        'categories': ['Q1', 'Q2', 'Q3', 'Q4'],
        'series': [
            {'name': '收入', 'values': [10, 15, 13, 18], 'chart_type': 'COLUMN_CLUSTERED'},
            {'name': '增长率', 'values': [0.1, 0.5, 0.3, 0.6], 'chart_type': 'LINE', 'secondary_axis': True},
        ],
    }, x=0.8, y=1.5, w=8.4, h=3.5, palette='midnight', title='收入与增长率（组合图）', show_value=True)
    prs.save('chartlib-self-test.pptx')
    print('WROTE chartlib-self-test.pptx')
