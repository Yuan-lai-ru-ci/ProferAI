# chartlib.py —— Profer 高级图表封装库使用文档

> 解决 pptxgenjs 做不了的高级图表：**组合图 / 双 Y 轴 / 84 种图表类型 / 精细美化**。
> 基于 python-pptx，统一接口 `add_chart()`，Agent 传数据 + 选类型 + 选配色即可，不碰底层 XML。
> 位置：`skills/pptx/scripts/chartlib.py`

---

## 一、能力总览

| 能力 | 状态 |
|------|------|
| 84 种图表类型（含股票K线、曲面、雷达变体、锥形柱、饼中饼、三维等） | ✅ 全量封装 |
| 组合图（柱+线等异类型叠加） | ✅ 已实测（PowerPoint 可打开） |
| 双 Y 轴（次坐标轴靠右） | ✅ 已实测 |
| 配色方案（10 套，与设计系统对齐） | ✅ 自动 |
| 美化默认值（去多余网格/图例、数据标签、轴标签弱化） | ✅ 自动 |
| 折线平滑、图表区圆角 | ✅ 支持 |

---

## 二、核心 API

### add_chart(slide, chart_type, data, x, y, w, h, ...)

```python
from chartlib import add_chart, new_presentation, add_blank_slide

prs = new_presentation()          # 10"×5.625" 16:9
slide = add_blank_slide(prs)

# 普通图表：多系列柱状图
add_chart(slide, 'COLUMN_CLUSTERED', {
    'categories': ['Q1', 'Q2', 'Q3', 'Q4'],
    'series': [
        {'name': '收入', 'values': [10, 15, 13, 18]},
        {'name': '成本', 'values': [6, 8, 7, 9]},
    ],
}, x=0.8, y=1.5, w=8.4, h=3.5, palette='midnight', title='季度营收')

prs.save('out.pptx')
```

### 主要参数

| 参数 | 说明 | 默认 |
|------|------|------|
| `chart_type` | 字符串或 XL_CHART_TYPE。常用：`'COLUMN_CLUSTERED'`/`'LINE'`/`'PIE'`/`'DOUGHNUT'`/`'AREA'`/`'RADAR'`/`'SCATTER'`/`'BUBBLE'`。全 84 种用 XL_CHART_TYPE 成员名 | 必填 |
| `data.categories` | 类目标签列表 | 必填 |
| `data.series` | `[{'name','values'[, 'chart_type','secondary_axis']}]` | 必填 |
| `palette` | 配色方案名：midnight/forest/coral/terracotta/ocean/charcoal/teal/berry/sage/cherry | 'midnight' |
| `title` | 图表标题，None 不显示 | None |
| `show_legend` | 图例；None=多系列自动显示、单系列隐藏 | None |
| `show_value` | 数据标签 | False |
| `line_smooth` | 折线平滑 | False |
| `rounded_corners` | 图表区圆角 | False |
| `val_gridline` / `cat_gridline` | 数值/类别网格线 | True/False |

---

## 三、组合图 + 双 Y 轴（核心能力）

```python
# 柱 + 线 双轴组合图
add_chart(slide, 'COLUMN_LINE', {
    'categories': ['Q1', 'Q2', 'Q3', 'Q4'],
    'series': [
        {'name': '收入',   'values': [10, 15, 13, 18], 'chart_type': 'COLUMN_CLUSTERED'},
        {'name': '增长率', 'values': [0.1, 0.5, 0.3, 0.6], 'chart_type': 'LINE', 'secondary_axis': True},
    ],
}, x=0.8, y=1.5, w=8.4, h=3.5, palette='midnight', show_value=True)
```

规则：
- 第一个 series 决定柱的类型，后面的 series 通过 `chart_type` 指定异类型。
- 标 `secondary_axis: True` 的 series 会挂到右侧次坐标轴（双 Y 轴）。
- 可组合的类型：COLUMN_CLUSTERED / LINE / LINE_MARKERS / AREA / PIE / DOUGHNUT / XY_SCATTER / RADAR / BUBBLE。

---

## 四、关键实现要点（给维护者，重要！）

组合图是 OOXML 里最复杂、最容易破坏文件的场景。下面是**实测踩坑后固化下来的铁律**，改代码前必读：

1. **所有 chart 容器必须在所有轴之前**：plotArea 顺序 = `barChart/lineChart... → catAx/valAx... → dTable/spPr/extLst`。拆 series 时新容器要 `_insert_before_axes` 插到轴之前，不能 append 到末尾。
2. **每个 chart 容器必须恰好 2 个 axId**，且在 ser 之后（`CT_BarChart`/`CT_LineChart` 都要求 `axId minOccurs=2 maxOccurs=2`）。
3. **lineChart 的 grouping 合法值只有 `standard`/`stacked`/`percentStacked`**，绝对不能从 barChart 复制 `clustered`（非法）。
4. 🔴 **不要修正 axId 符号**：python-pptx 生成的负数 axId（如 `-2113994440`）在 PowerPoint 里能正常打开，强制转 unsigned 会打断 axId↔crossAx 成对引用，破坏文件。
5. 🔴 **不要重新编号 order**：`c:order` 是跨整个 chart 唯一的系列序号（0,1,2...），拆分到不同容器后必须保持原值，按容器内重编会造成跨容器 order 冲突，破坏文件。
6. **次轴绑定用 `c:idx`（系列全局索引）判断**，不是 order（order 会被复制过程影响）。
7. **组合图拆分必须放在所有 python-pptx 对象模型美化操作之后**，否则对象模型在拆分后误写。

> 这两个 🔴 是这次踩坑的核心教训：schema 校验器会报 "unsignedInt 无效" 误导人去转正 axId，但真实 PowerPoint 接受负数 axId，转正反而坏事。**schema 通过 ≠ PowerPoint 能打开，最终必须用 PowerPoint COM 打开 + 转图验证。**

---

## 五、验证方法（写图表必做）

```bash
# 生成
python your_script.py
# 用 PowerPoint COM 打开 + 转图（关键！schema 通过不代表能打开）
powershell -File office/pptx2png.ps1 -InputPath out.pptx
```

**判断标准**：PowerPoint 能否 `Open` 成功（不报 HRESULT E_FAIL）是组合图唯一的正确性判据。

---

## 六、依赖

- `python-pptx`（已装）
- `lxml`（已装）
- 无需 LibreOffice/Poppler（转图用本机 PowerPoint COM）
