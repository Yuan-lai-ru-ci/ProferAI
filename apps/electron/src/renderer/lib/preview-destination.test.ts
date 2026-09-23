import { describe, expect, test } from 'bun:test'

import { IMAGE_PREVIEW_EXTS, PANEL_ONLY_PREVIEW_EXTS } from './preview-extension-sets'
import { resolvePreviewDestination } from './preview-destination'

describe('文件点开去哪儿', () => {
  test('OFV 承担的长尾格式 → 浏览器列的 viewer 页', () => {
    for (const path of [
      '/tmp/a/sample.doc',
      '/tmp/a/sample.xls',
      '/tmp/a/sample.ppt',
      '/tmp/a/sample.xlsx',
      '/tmp/a/sample.zip',
      '/tmp/a/sample.psd',
      '/tmp/a/sample.ttf',
      '/tmp/a/sample.mp3',
      '/tmp/a/clip.mp4',
      '/tmp/a/model.glb',
      '/tmp/a/design.fbx',
      '/tmp/a/bundle.tar',
      '/tmp/a/bundle.rar',
    ]) {
      expect(resolvePreviewDestination(path)).toBe('ofv-viewer')
    }
  })

  test('OFV 插件覆盖但历史上漏在清单外的格式（已补齐 2026-09-18）→ viewer 页', () => {
    // 这批此前会落到文本/代码兜底渲染器：压缩包 / OLE 二进制被当 UTF-8 渲成乱码。
    // 口径见 `ofv-extensions.ts` 的 OFV_EXTRA_EXTS：只收「今天会乱码」的，能当文本读的不动。
    for (const path of [
      // 电子书 / 版式文档 / 邮件 / 脑图
      '/tmp/a/mail.eml',
      '/tmp/a/mail.msg',
      '/tmp/a/mail.mbox',
      '/tmp/a/book.epub',
      '/tmp/a/form.ofd',
      '/tmp/a/doc.xps',
      '/tmp/a/doc.oxps',
      '/tmp/a/mind.xmind',
      // 需要解码器的图片（Chromium 的 <img> 画不出来）
      '/tmp/a/photo.heic',
      '/tmp/a/photo.heif',
      '/tmp/a/scan.tiff',
      '/tmp/a/scan.tif',
      '/tmp/a/pic.jxl',
      '/tmp/a/cursor.cur',
      // Office 家族其余扩展名
      '/tmp/a/macro.docm',
      '/tmp/a/tpl.dotx',
      '/tmp/a/book.xlsb',
      '/tmp/a/sheet.xlsm',
      '/tmp/a/slides.pptm',
      '/tmp/a/notes.odt',
      '/tmp/a/notes.ods',
      '/tmp/a/notes.odp',
      '/tmp/a/rich.rtf',
      '/tmp/a/apple.numbers',
      '/tmp/a/apple.key',
      // 设计 / 资产 / 3D
      '/tmp/a/vector.eps',
      '/tmp/a/print.ps',
      '/tmp/a/big.psb',
      '/tmp/a/column.parquet',
      '/tmp/a/events.avro',
      '/tmp/a/page.webarchive',
      '/tmp/a/mesh.stl',
      '/tmp/a/mesh.ply',
      '/tmp/a/scene.3mf',
      '/tmp/a/scene.usdz',
    ]) {
      expect(resolvePreviewDestination(path)).toBe('ofv-viewer')
    }
  })

  test('文本 / 代码与 Browser 列内预览', () => {
    // 这些格式 OFV 也有插件（office/gis/drawing），但今天作为文本是可读的，
    // 换视图属于另一种取舍 —— 改动前先看 `OFV_EXTRA_EXTS` 的注释。
    for (const path of [
      '/tmp/a/data.csv',
      '/tmp/a/data.tsv',
      '/tmp/a/map.geojson',
      '/tmp/a/track.kml',
      '/tmp/a/route.gpx',
      '/tmp/a/diagram.drawio',
      '/tmp/a/sketch.excalidraw',
      '/tmp/a/plan.dxf',
      '/tmp/a/model.dae',
      '/tmp/a/world.wrl',
    ]) {
      expect(resolvePreviewDestination(path)).toBe('browser-inline')
    }
    // `.obj` 双义（三维模型 / 编译产物）：仍在 Browser 列内显示统一的不可预览提示
    expect(resolvePreviewDestination('/tmp/a/compiled.obj')).toBe('browser-inline')
  })

  test('文本 / 代码与 Browser 列内预览', () => {
    for (const path of [
      '/tmp/a/main.ts',
      '/tmp/a/App.tsx',
      '/tmp/a/styles.css',
      '/tmp/a/theme.scss',
      '/tmp/a/index.js',
      '/tmp/a/config.json',
      '/tmp/a/config.yaml',
      '/tmp/a/notes.log',
      '/tmp/a/readme.txt',
      '/tmp/a/script.sh',
      '/tmp/a/query.sql',
      '/tmp/a/main.rs',
      // 无扩展名的文本（没有点，或点名以点开头）同样按文本处理
      '/tmp/a/Makefile',
      '/tmp/a/LICENSE',
      '/tmp/a/.gitignore',
    ]) {
      expect(resolvePreviewDestination(path)).toBe('browser-inline')
    }
  })

  test('静态图 → Browser 列内预览', () => {
    for (const extension of IMAGE_PREVIEW_EXTS) {
      expect(resolvePreviewDestination(`/tmp/a/pic${extension}`)).toBe('browser-inline')
    }
    // 图片清单与「OFV 专属解码图片」不该重叠：重叠会让路由先被 OFV 抢走
    for (const extension of ['.tif', '.tiff', '.heic', '.heif', '.jxl', '.cur']) {
      expect(IMAGE_PREVIEW_EXTS.has(extension)).toBe(false)
      expect(resolvePreviewDestination(`/tmp/a/pic${extension}`)).toBe('ofv-viewer')
    }
  })

  test('原先面板专属的格式 → 右侧 Browser 列内预览', () => {
    for (const extension of PANEL_ONLY_PREVIEW_EXTS) {
      expect(resolvePreviewDestination(`/tmp/a/file${extension}`)).toBe('browser-inline')
    }
    // 大小写不敏感
    expect(resolvePreviewDestination('/tmp/a/README.MD')).toBe('browser-inline')
    expect(resolvePreviewDestination('/tmp/a/REPORT.DOCX')).toBe('browser-inline')
  })

  test('连 OFV 都做不了的二进制 → Browser 列内给出「不支持预览 + 扩展名」的准话', () => {
    for (const path of ['/tmp/a/app.exe', '/tmp/a/lib.dylib', '/tmp/a/img.iso', '/tmp/a/blob.dat', '/tmp/a/x.o', '/tmp/a/setup.pkg']) {
      expect(resolvePreviewDestination(path)).toBe('browser-inline')
    }
  })

  test('所有非 OFV 文件都不再分流到旧的预览面板', () => {
    for (const path of [
      '/tmp/a/compiled.obj',
      '/tmp/a/app.exe',
      '/tmp/a/README.MD',
      '/tmp/a/REPORT.DOCX',
      '/tmp/a/report.pdf',
    ]) {
      expect(resolvePreviewDestination(path)).not.toBe('panel')
    }
    // 老式 Office 仍由右侧 Browser 的 OFV viewer 承担。
    for (const extension of ['.doc', '.xls', '.ppt']) {
      expect(PANEL_ONLY_PREVIEW_EXTS.has(extension)).toBe(false)
      expect(resolvePreviewDestination(`/tmp/a/file${extension}`)).toBe('ofv-viewer')
    }
  })
})
