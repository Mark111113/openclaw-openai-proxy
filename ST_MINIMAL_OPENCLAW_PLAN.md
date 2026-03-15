# OpenClaw ST 专用极简实例方案

## 背景

当前 `claw-proxy` 接入 `SillyTavern` 时，虽然已经能跑通 OpenAI-compatible 接口，但存在两个核心问题：

1. **上游实际命中模型不稳定**
   - `claw-proxy` 配置中的 `upstreamModel` 与 OpenClaw 实际执行模型不一致。
   - 实测出现：配置为 `bailian/kimi-k2.5`，实际命中 `998code/gpt-5.4`。

2. **OpenClaw 主实例加工过重**
   - 当前主实例带有个人助理上下文、工作区人格文件、记忆、技能与后台逻辑。
   - 对 SillyTavern 的角色扮演/18R 场景来说，这会显著增加“加工”“约束”“审查感”。

因此，需要一个更贴合目标的方案。

---

## 目标

建立一个 **SillyTavern 专用的极简 OpenClaw 实例**，满足：

- 请求仍然 **经过 OpenClaw**
- 对上游 API 来说，请求仍然来自 **OpenClaw runtime**
- 相比当前主实例，显著减少：
  - system prompt 负担
  - workspace 注入
  - personal memory
  - 私人助理逻辑
  - 工具/技能干扰
- 默认模型直接固定为指定模型（如 `bailian/kimi-k2.5`）
- 由 `claw-proxy` 专门接入这个实例，而不是接主实例

---

## 不追求的目标

这个方案 **不追求**：

- 与 SillyTavern 直连上游 API 完全等价
- 完全零加工
- 完全去除 OpenClaw runtime 的 system prompt / session / provider routing

只要仍然通过 OpenClaw agent/chat runtime，就一定会保留一层 OpenClaw 自身逻辑。

---

## 推荐架构

```text
SillyTavern
  -> claw-proxy
  -> OpenClaw-ST (极简实例)
  -> 上游 LLM API
```

### 角色分工

#### SillyTavern
- 负责角色卡、上下文、采样参数

#### claw-proxy
- 提供 OpenAI-compatible 接口
- 负责鉴权、基础兼容层、调试头、服务化管理
- 不再尝试把会话 override 硬 patch 到主实例

#### OpenClaw-ST
- 专门服务于 ST
- 保留 OpenClaw runtime，但尽量极简
- 默认模型固定为目标模型
- 不承载主实例的“私人助理”职责

---

## 极简实例的设计原则

## 1. 独立 workspace

建议使用独立 workspace，例如：

```bash
/root/.openclaw-st/workspace
```

### 只保留最小文件

#### `AGENTS.md`
仅保留最少规则，例如：
- 此实例专用于 SillyTavern
- 不主动调用工具
- 不做生活助理式补充
- 尽量忠实响应输入

#### `SOUL.md`
极短，避免人格化

#### 其他文件
原则上：
- 不放 `MEMORY.md`
- 不放 `USER.md`
- 不放 daily `memory/*.md`
- 不放 `HEARTBEAT.md`
- 不放 `TOOLS.md` 中的私人环境信息
- 不放 `BOOTSTRAP.md`

---

## 2. 极少工具 / 最少技能

目标：
- 尽量不让模型感知自己是一个“有很多能力的私人助理”
- 减少工具调用倾向
- 减少额外安全/行为路径

建议：
- 关闭或最小化大多数工具可见性
- 不接入 Feishu / Telegram / Message 路由到这个实例
- 不让此实例承载消息发送、浏览器、文件操作等强工具集

---

## 3. 固定默认模型

这个实例的默认模型应直接设为目标模型，例如：

```text
bailian/kimi-k2.5
```

这样：
- 不依赖 `claw-proxy` 去 patch session override
- 不和主实例默认模型混淆
- 行为更稳定、可预测

---

## 4. 独立 state / session

建议独立 state 目录，避免和当前主实例共享 session 污染。

例如：

```bash
/root/.openclaw-st
```

里面单独保存：
- gateway 配置
- session store
- logs
- model defaults

这样可以避免：
- 主实例 session 污染 ST 结果
- 主实例 memory / model / profile 影响 ST 实例

---

## 5. 不接主消息通道

这个极简实例不建议接：
- Feishu
- Telegram
- WhatsApp
- Discord
- 心跳任务
- 私人助理定时任务

否则又会把“私人助理逻辑”带回来。

---

## 当前可先采取的临时方案

在没有资源立即搭第二实例时，现有实例里如果想让 `claw-proxy` **更稳定地用 `kimi-k2.5`**，最稳妥的临时方案是：

## 直接把 OpenClaw 当前默认模型改成目标模型

例如改成：

```text
bailian/kimi-k2.5
```

### 原因

当前实测表明：
- `claw-proxy` 配置里的 `upstreamModel` 会显示为已配置
- 但实际 agent run 仍可能落到 OpenClaw 当前默认模型

因此在现阶段：
- **改主实例默认模型**，比依赖 proxy patch session override 更可靠

### 代价

- 主实例上其它对话也会一起受影响
- 对你当前个人助理会话也可能产生副作用

所以这只适合做临时验证，不适合长期方案。

---

## 实施建议（未来）

当有资源推进时，建议按以下顺序落地：

### Phase 1：新实例骨架
- 独立目录
- 独立 workspace
- 极简 AGENTS/SOUL
- 独立 systemd 服务

### Phase 2：固定模型
- 把新实例默认模型设为目标模型
- 验证 OpenClaw 直跑时确实命中该模型

### Phase 3：切换 proxy
- 让 `claw-proxy` 指向新实例
- 不再复用主实例

### Phase 4：A/B 联调
- 对比：
  - 主实例
  - 极简 ST 实例
  - SillyTavern 直连
- 观察审查强度、风格偏移、角色一致性

---

## 结论

如果目标是：

- 仍然经过 OpenClaw
- 对上游看起来像 OpenClaw 发起
- 但尽量减少加工与约束

那么最合适的长期方案不是继续硬拧当前主实例，也不是纯 passthrough，而是：

## **建立一个 SillyTavern 专用的极简 OpenClaw 第二实例**

在资源暂时不够时，现有实例下想稳定让 `claw-proxy` 走 `kimi-k2.5`，最现实的临时方案是：

## **先把 OpenClaw 当前默认模型改成 `bailian/kimi-k2.5`**

