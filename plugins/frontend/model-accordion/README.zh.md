# Model Accordion

**简体中文** · [English](./README.md)

> 把 QwenPaw 聊天页的模型选择器变成**单开手风琴**，并把常用模型**收藏置顶**。
> 参考 [dsh-model-accordion](https://github.com/lllbjs/dsh-model-accordion) 的核心理念移植：
> **只装饰 DOM，不重写选择器** —— 模型选择、OAuth 校验、免费模型切换确认仍全部由宿主负责。

## 功能

| 功能 | 用法 |
| --- | --- |
| **单开手风琴** | 点击供应商标题：它展开，其他供应商自动收起；再点一次收起。 |
| **多开** | `Ctrl`/`Cmd` + 点击标题，切换该供应商而不关闭其他。 |
| **全部展开 / 收起** | 搜索行右侧工具栏 `⊞` / `⊟`。 |
| **收藏置顶** | 每个模型行右侧的星标：点击收藏，不会顺带切换模型；收藏固定在列表顶部 `★` 分组，点击即选中。 |
| **收藏键稳定** | 收藏键优先用 `providerId/modelId`（来自 `/api/models` 与 DOM 的 `data-provider-id`），改名不掉收藏；重名模型退回 `providerId/模型名 + 行序号`。 |
| **下线标记** | 收藏的模型被删除后显示「已下线」，点星标移除。 |
| **模型数徽标** | 供应商标题显示 `· N`；收起且含当前模型时显示 `● 模型名 · N`。 |
| **供应商排序** | 工具栏 `↺` 循环：默认 → 名称 A→Z → 模型数量 ↓N（用 CSS `order` 实现，不移动 React 节点）。 |
| **状态记忆** | 展开状态、收藏、排序都存 `localStorage`，关菜单、刷新页面后保留。 |
| **搜索穿透** | 搜索时宿主自动展开所有供应商，插件不做折叠干预；收藏区同步按关键字过滤。 |
| **键盘操作** | 搜索框 `↓` 进入标题；`↑`/`↓` 在标题间移动；`→`/`←` 展开/收起；收藏行可 Tab 聚焦、Enter 选中。 |
| **中英双语** | 跟随 Console 语言设置（`localStorage.language`）。 |

## 安装

```sh
./install.sh
```

脚本优先调用运行中后端的 `POST /api/plugins/install`（热加载，无需重启）；
后端不可达时回退为软链到 `~/.qwenpaw/plugins/model-accordion`（需重启应用）。
安装后**刷新 Console 页面**即可加载前端 bundle。

卸载：在插件管理页卸载 `model-accordion`，或删除 `~/.qwenpaw/plugins/model-accordion` 后重启。

## 实现原理

```
plugin.json      type=frontend，entry.frontend=lib/client.js，无后端、无构建依赖
lib/client.js    原生 ES module，由 Console 的 /api/frontend_plugin 加载器执行
install.sh       热安装 / 软链回退
```

1. `document.body` 上挂 `MutationObserver`（rAF 节流），识别
   `div[class*="listContainer"][role="region"]`（CSS Modules hash 不影响匹配）。
2. 工具栏注入搜索行；星标注入模型行；收藏区 prepend 到列表顶部；徽标插入标题。
   所有注入节点带 `data-qma-*` 标记，可整体 dispose（热重载安全）。
3. 单开/全收全展/恢复记忆都通过**合成点击宿主自己的标题按钮**实现，折叠状态仍由
   宿主 React state 管理；合成点击有 guard，不会递归触发插件逻辑。
4. 供应商数量、当前模型、收藏 modelId 解析来自只读 `GET /api/models` 与
   `GET /api/models/active`（5 秒节流）；**不读取、不存储任何凭据字段**。
5. 排序用 flex `order`，不移动 React 管理的 DOM 节点，避免 reconciliation 冲突。

## 存储

| 键（localStorage） | 值 |
| --- | --- |
| `qwenpaw-model-accordion:favorites` | `[{p, m, n, i}]`：供应商键 / modelId / 显示名 / 重名行序号 |
| `qwenpaw-model-accordion:sort` | `default` \| `name` \| `size` |
| `qwenpaw-model-accordion:single-open` | 单开开关（默认 `true`，预留） |
| `qwenpaw-model-accordion:open` | 展开供应商键的 JSON 数组 |

## 诊断

页面控制台访问 `window.__qwenpawModelAccordion`：

```js
__qwenpawModelAccordion.version      // "0.1.0"
__qwenpawModelAccordion.rescan()     // 重新扫描 DOM
__qwenpawModelAccordion.state()      // 每个面板的分组/折叠/模型数
__qwenpawModelAccordion.favorites()  // 收藏数组
__qwenpawModelAccordion.sort()       // 当前排序
__qwenpawModelAccordion.refresh()    // 强制重拉 /api/models
__qwenpawModelAccordion.dispose()    // 移除全部注入与监听（热重载用）
```

若模型列表出现但识别不到供应商分组，控制台会打印
`[qwenpaw-model-accordion] a model list is present but no provider sections were found`，
说明宿主菜单结构变了，需要更新 `lib/client.js` 里的 `SEL` 选择器。

## 限制

- 折叠时宿主不渲染模型行，数量徽标依赖 `/api/models` 缓存；接口不可达时徽标隐藏。
- 同一供应商下的重名模型无法从 DOM 区分 id，收藏按名字 + 行序号定位。
- 免费页签里的收藏若属于付费模型，点击时会自动切回 Pro 页签再选中。

## 许可证

Apache-2.0（与 QwenPaw 主仓库一致）。