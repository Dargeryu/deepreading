# Deepreading · 把书听成故事

参考 Readify（Deepreads LLC）的本地版听书应用：**无服务器、无上传**，
所有书籍、进度、Key 只保存在本机浏览器。

## v2 新增

- **正版搜书**：Open Library（借阅）＋ Project Gutenberg（公版免费下载 EPUB）
- **更多格式**：PDF / EPUB / TXT / DOCX / FB2 / HTML / MD
- **自定义 TTS API**：填自己的服务商地址＋Key＋Voice ID，即可用克隆音色
  （克隆在服务商侧完成，如 ElevenLabs / MiniMax，本应用只负责调用）
- **背景音**：雨声 / 咖啡馆 / 白噪音 / 森林夜晚（Web Audio 实时合成）＋音量
- **排版**：字号 / 衬线-黑体 / 行高 / 四种主题（夜间/白天/护眼/墨黑）
- **下载原文件**：书架每本书可下载当初导入的原文件
- **✦ AI 助手**（需自备 Gemini API Key，Google AI Studio 免费获取）：
  - 讲解：选中正文 → AI 讲清意思、背景、关键点
  - 费曼模式：大白话重讲＋打比方＋自测题，可一键朗读
  - 类比·动态：不懂的概念 → AI 生成 4 格类比分镜，自动播放＋配音讲解
- 选中正文任意文字，自动弹出"AI 讲解"快捷入口

## v1 功能（保留）

| Readify 功能 | Deepreading 实现 |
|---|---|
| 导入 PDF / EPUB / 文章 | ✅ PDF / EPUB / TXT 本地导入（多选＋解析进度条） |
| 复杂 PDF 智能解析（跳过页眉页脚页码） | ✅ 启发式去重：重复 3 页以上的短行视为页眉页脚，纯数字页码行丢弃 |
| 100+ 神经网络音色 | ✅ 系统语音（Chrome/Edge/Safari 自带，通常几十种，中英日韩等） |
| 50+ 语言自动识别切换 | ✅ 按中日韩字符占比自动判定中/英文并匹配对应音色 |
| 从上次位置继续 | ✅ 逐句保存进度，书架显示百分比，重进自动回到上次位置 |
| 小说多角色配音 | ✅ 可选"对话用第二个音色"（引号内对白自动换音色） |
| 离线使用 | ✅ 纯前端，pdf.js / jszip 已内置，无需联网（语音用系统离线音色） |
| 语速调节 | ✅ 0.5x – 2.0x |
| 章节目录 | ✅ TXT 按"第X章"识别；EPUB 按 spine 章节；PDF 同 TXT 规则 |
| 播放时屏幕常亮 | ✅ Wake Lock API（Chrome/Android） |

## 使用

1. 解压，在手机/电脑浏览器打开 `index.html`
   （或 `cd deepreading && python3 -m http.server 8000` 后访问 `http://localhost:8000`）
2. 点"导入"，选 PDF / EPUB / TXT
3. 点书封面进入，点 ▶ 开始听；点任意句子可跳转；⚙ 里换音色、调语速

## 说明与限制

- 语音质量取决于本机系统语音；想要更好的中文音色可在系统设置里下载
  （Windows：设置→时间和语言→语音→添加中文语音；Android：Google 文字转语音）
- 浏览器后台/锁屏后，系统可能暂停朗读（这是 Web Speech API 的平台限制，
  不是 bug）；保持 Deepreading 在前台＋屏幕常亮可避免
- 不支持扫描版 PDF（图片型，无文字层）；DRM 加密的 EPUB 无法解析
- 数据存在浏览器 IndexedDB：**清浏览器数据会丢书**，重要书籍请保留原文件

## 目录结构

```
deepreading/
  index.html        入口
  css/styles.css    深色阅读主题
  js/app.js         全部逻辑（解析/书架/朗读/进度）
  lib/              pdf.js 3.11 + jszip 3.10（本地，无需 CDN）
```
