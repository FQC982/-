# 拾光泼溅 · Splat Memoriae

把一段时光，泼溅成可以走回去的空间。

一个以 **3D Gaussian Splatting（3DGS / 高斯泼溅）** 为核心概念的个人记忆重建馆：上传一段环绕视频或一张照片，浏览器端即刻把像素还原为可环视、可推拉的立体场景；被桌子挡住的部分、镜头外的世界，由"推测层"补全，并给空间里每一个点一个身份（已知 / 推测 + 置信度）。

- 在线演示：https://splat-memoriae-lsu3ckfg7qn.qoder.website
- 源码压缩包：`splat-memory-source.zip`（与本仓库源码一致，解压即用）

## 四个界面

| 界面 | 内容 |
| --- | --- |
| 主页 | 高斯泼溅 hero 场景 + 12 项泼溅控制台（重建进度 / 密度 / 尺寸 / 环绕速度 / 景深雾 / 显示模式 / 自动环绕 / 已知·推测 / 置信度着色 / 重置 / 随机 / 快照），上传重建管线与四道工序说明 |
| 示例 | 8 件策展示例（宿舍 / 校园 / 城市 / 自然），分类筛选与排序，点击进入泼溅查看器 |
| 个人记忆体 | 本地记忆卡片：重建状态、火漆封存、批注抽屉、删除可撤销、重建中进度自动完成 |
| 我的 | 手机号 + 密码注册登录（**无短信验证码**）、SHA-256 密码哈希、资料与存储用量、画质 / 默认密度 / 环境音 / 自动环绕设置、修改密码与退出 |

## 核心技术

- **零依赖 WebGL 高斯椭球渲染器**（`js/splat.js`）：每个 splat 带位置、双轴尺度、旋转、颜色、透明度；片元按投影椭圆做高斯衰减，预乘 alpha 混合 + 计数排序远→近；WebGL2 / `OES_element_index_uint` 不可用时降级加色点渲染；无 WebGL 时降级静态海报。
- **单图"已知 → 未知"补全**：单目深度代理分层，前景为已知层；桌后背层与画外延拓层由镜像纹理 + 模糊 + 色彩延续生成，每点带身份与置信度；控制台可切换"仅已知 / 仅推测 / 全部"与置信度着色（已知绿 / 推测紫）。
- **视频多视角融合**：抽帧后做下采样块匹配视差 → 三角化深度 → 按置信度与被见帧数融合，单帧区域由推测层补全。
- **真 3DGS 导入通道**：支持 `.splat` / `.ply`（binary little endian，含 SH DC 颜色、sigmoid 透明度、log 尺度、四元数旋转）原样渲染；`.ksplat` 给出转换指引。采集引导：环绕慢移 1–3 分钟、帧间重叠 ≥ 70%。
- **端侧优先状态**：localStorage 持久化设置 / 用户 / 会话 / 记忆体；密码 SHA-256（`crypto.subtle`，含 FNV 降级）。
- **移动端安全的环境音**：单一 master 总线，cancel + 锚点 + 短 fade；静音 fade 后 `suspend`、开启 resume 后 fade in；`statechange` / `visibilitychange` / `pageshow` / 每次手势统一恢复；慢速 detune LFO 替代固定拍频、无缝交叉淡化噪声循环；coarse pointer 自动降低增益。

## 本地运行

纯静态、无构建步骤。因使用 ES Module，请通过任意静态服务器打开（不要直接双击 `index.html`）：

```bash
npx serve .
# 或
python -m http.server 8123
```

然后访问 `http://127.0.0.1:8123/`（端口依所选服务器而定）。

## 目录结构

```
index.html          四界面 + 顶栏 / 底栏 / 管线覆盖层 / 查看器 / 抽屉 / toast
styles.css          博物馆式设计系统（墨色 + 琥珀 + 冰蓝）与响应式
js/splat.js         WebGL 高斯椭球引擎、视差融合、.splat/.ply 解析、抽帧
js/app.js           状态与四界面逻辑、声音架构、上传管线、导入通道
assets/             场景图 / 记忆图 / 火漆 / 海报 / favicon（webp/svg）
```

## 边界说明

浏览器端完成预览、补全与导入渲染；完整 SfM 位姿估计与 3DGS 训练需要 GPU，由云端队列或离线工具（COLMAP / nerfstudio splatfacto / OpenSplat / Brush）完成，手机 App（Scaniverse / Polycam / KIRI）可直接产出 splat 文件跳过训练。

沿承拾光校园时光记忆体 · MMXXVI