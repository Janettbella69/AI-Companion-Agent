# HSHH-robot — AI 情感陪伴宠物 PRD

| 项目 | 内容 |
|---|---|
| 版本 | v0.4 |
| 日期 | 2026-08-14 |
| 状态 | P0 Build Ready |
| 适用对象 | 黑客松 Builder、产品、固件、后端、设计与演示团队 |
| 代码仓库 | <https://github.com/Janettbella69/AI-Companion-Agent> |

**产品一句话：** 一只拥有定制宠物外观、会先征得同意再主动靠近、能被用户抱起，并会记住彼此互动方式的自主 AI 角色宠物。

---

## 0. 执行摘要

HSHH-robot 的目标不是把聊天机器人装进带轮子的屏幕，而是验证一个更具体的情感闭环：

> 发现用户 → 主动表达关注 → 请求靠近 → 安全移动 → 试探性理解情绪 → 邀请拥抱 → 被抱起后反馈 → 写入共同记忆 → 下一次自然回忆

P0 面向黑客松现场，必须突出五项差异化能力：

1. **多模态理解与表达**：同时使用语音/文本、触发式视觉和本地传感器事件理解当前场景，并通过短句、声音、屏幕表情和安全动作协调反馈。
2. **主动靠近**：机器人先注意到用户并发出邀请，在取得同意后完成短距离靠近。
3. **宠物照片转形象**：用户上传真实宠物照片，生成可在设备端稳定播放的统一身份表情包。
4. **长期记忆**：机器人能跨会话记住用户明确表达的称呼、偏好或共同事件。
5. **可拥抱的自主角色**：单舵机联动双臂张开邀请，由用户主动抱起；机器人不夹抱、不以大模型直接控制电机。

P0 采用“单 Agent 云端认知 + MCP 能力层 + 本地确定性安全”的架构：Tuya T5 与 ESP32-S3 将带时间戳的语音、触发式图像、手势、距离和姿态事件汇入后端上下文入口；唯一核心 Agent 必须基于 Claude Agent SDK，并完整保留 Claude Code 的 Agent Loop、Bash、Read、Edit、Write、代码执行、ToolSearch 和 Skill 等原生能力。机器人领域能力通过 MCP 工具、Skills、参考资料和辅助代码扩展；ESP32-S3 继续独立负责电机、舵机和确定性安全状态机。

## 1. 产品背景与用户价值

### 1.1 用户问题

- 纯软件陪伴产品能聊天，但缺少空间存在、主动接近和触觉互动。
- 普通电子宠物往往只能在用户触发后响应，长期关系感较弱。
- 通用移动机器人通常偏工具或娱乐，难以形成“它在意我”的体验。
- 真实宠物具有陪伴价值，但用户可能受到居住、过敏、时间和照料成本限制。

### 1.2 目标用户

P0 主要验证对象是喜欢宠物、潮玩和新型交互硬件，且愿意体验 AI 陪伴的成年人。典型场景包括：

- 无法长期饲养真实宠物，但希望获得陪伴和迎接感。
- 希望把真实宠物的照片、毛色和特征保留在数字角色中。
- 希望 AI 不只回答问题，也能通过靠近、停顿、表情和被抱起反馈表达关系。

P0 不面向无人监护的儿童、医疗照护、高风险心理支持或家庭监控场景。

### 1.3 Jobs to Be Done

- 当我出现在它附近时，我希望它先注意到我，并用不冒犯的方式询问是否可以过来。
- 当我疲惫或不想组织语言时，我希望它先询问，而不是断言我的情绪。
- 当我想拥抱时，我希望动作容易理解、随时可以拒绝，并且不会夹伤我。
- 当我下次再见到它时，我希望它记得我们共同确认过的偏好，而不是每天重新开始。
- 当我上传宠物照片时，我希望所有表情仍像同一只宠物，而不是每帧换一张脸。

## 2. 产品目标、非目标与原则

### 2.1 P0 目标

- 在受控平地完成一次可重复的“发现—同意—靠近—邀请—抱起—记忆”闭环。
- 在设备上展示基础表情与宠物定制表情，资源失败时可自动回退。
- 演示跨 Agent Session 的长期记忆检索和用户纠正。
- 在一次完整互动中融合语音/文本、触发式视觉和本地传感器三类输入，并协调至少两类输出通道完成反馈。
- 用带置信度和有效期的情绪线索影响陪伴方式，但不把推测当成事实。
- 断网或 Agent 超时时，本地仍能停止电机、释放拥抱姿态和播放基础反馈。

### 2.2 P0 非目标

- 不做 SLAM、多房间地图、自由空间寻人和自主回充。
- 不做桌面边缘、楼梯或复杂家庭环境下的无人监督移动。
- 不做主动夹紧、力控回抱或环抱人体；P0 的“可拥抱”指用户可以安全抱起机器人。
- 不做持续人脸监控，也不承诺身份识别准确率。
- 不做持续视频流理解、开放环境视觉导航或要求所有模态始终在线的端到端模型。
- 不做面部七分类式“读心”、心理诊断、治疗建议或危险性判断。
- 不在 ESP32/T5 上运行完整大语言模型。
- 不允许生成模型输出 PWM、轮速、舵机角度或绕过安全状态机。
- 不使用普通 Anthropic/OpenAI API 调用、LangGraph、LangChain、Dify 或手写节点图替代 Claude Agent SDK 核心 Agent。
- 除 Deep Research 等确需并行研究的任务外，不使用多 Agent 拆分日常陪伴、控制、记忆或资源生成流程。

### 2.3 产品原则

- **先同意，后靠近**：主动表达关注不等于可以直接接触用户。
- **角色动作优先**：注视、停顿、转向、慢速靠近和表情比长篇台词更重要。
- **推测不是事实**：情绪识别必须保留 `unknown`，用户自述和纠正优先。
- **多模态互证、单模态可降级**：跨模态一致时提高判断可信度；输入缺失或冲突时降低置信度、请求澄清或退回安全默认行为。
- **记忆可解释、可删除**：系统要能说明记住了什么、为何记住。
- **安全独立于 AI**：本地控制器可拒绝任何过期、冲突或不安全的云端请求。
- **失败仍像宠物**：断网后保持基础表情、短句、手势反馈、停止和抱起反馈。
- **不操纵依恋**：不因用户拒绝而委屈施压，不用亲密行为推动付费。
- **Agent-first，不写死认知工作流**：由单个 Claude Agent SDK Agent 根据上下文自主选择 Skills、MCP 和原生工具；程序只固定权限、安全、数据契约和设备不变量。

## 3. 北极星体验

### 3.1 90 秒“它认出我了”体验

1. HSHH-robot 在 `idle` 状态播放自然眨眼或轻微呼吸动画。
2. T5 摄像头或 ESP32-CAM 的触发式视觉事件发现用户，并与近距事件共同让设备切换为 `noticed`。
3. 机器人转向用户并问：“我可以过去陪你吗？”
4. 用户说“可以”或在 APDS9960 前做确认手势；该明确事件生成短时 `consent_token`。
5. Claude Agent 输出高层技能 `approach_short`；ESP32-S3 检查本地安全条件后低速前进。
6. HC-SR04 以本地新鲜读数持续测距，机器人在约 25–45 cm 的邀请区间内停车并断开移动使能。
7. 机器人根据用户明确表达和当前线索问：“要我陪你一会儿吗？”而不是直接宣称用户难过。
8. 用户同意后，单个 SG90 通过对称连杆张开两条柔性手臂，设备进入 `invite_hug`。
9. 用户抱起机器人；BNO055 检测到离地与姿态变化，底盘保持禁用，设备播放开心表情、短句或呼噜声。
10. 用户说出一个明确偏好，例如“我累的时候喜欢安静一点”；系统展示候选记忆并保存。
11. 新建 Agent Session 后，机器人能在合适时机回忆这一偏好。

### 3.2 北极星指标

**成功完成且未触发安全中断的主动亲密互动次数。**

P0 只统计受控演示，不把该指标解释为长期留存或临床情绪改善。

## 4. P0 功能需求

### 4.1 主动发现与靠近

| ID | 需求 | 优先级 | P0 验收 |
|---|---|---|---|
| PROX-01 | 设备能从待机进入注意状态 | Must | 摄像、距离、手势或演示事件触发 `noticed`，无需遥控底盘 |
| PROX-02 | 移动前征得用户同意 | Must | 未收到明确确认时只能注视、说话或保持静止 |
| PROX-03 | 只执行短距离靠近技能 | Must | Agent 只能请求 `approach_short`，不能直接设置轮速 |
| PROX-04 | 本地障碍停车 | Must | 距离进入危险区、测距失效或通信超时时立即停止 |
| PROX-05 | 用户随时拒绝或停止 | Must | 语音“停”、否定手势、按钮或本地故障均可中断移动 |
| PROX-06 | 不安全环境不启动 | Must | 被抱起、倾倒、低电量、传感器异常或安全状态非 `ready` 时拒绝动作 |

P0 只在平整地面、封闭直线演示区运行。没有悬崖传感器时，禁止在桌面、台阶附近或无人看护环境运行。

### 4.2 宠物照片与外观定制

| ID | 需求 | 优先级 | P0 验收 |
|---|---|---|---|
| AVA-01 | 上传宠物照片 | Must | 接受 JPEG、PNG 或 WebP；拒绝空文件、超限文件和非图片 |
| AVA-02 | 生成统一宠物身份层 | Must | 保留毛色、花纹、耳形和脸部轮廓等可见特征 |
| AVA-03 | 生成完整表情资源包 | Must | 与现有 9 种表情、每种 5 帧的目录结构兼容 |
| AVA-04 | 设备端校验与原子切换 | Must | manifest 和文件校验全部通过后才从 `basic` 切换到 `pet` |
| AVA-05 | 失败回退 | Must | 生成、下载、解码或校验失败时继续使用内置 `basic` 资源 |
| AVA-06 | 原始照片隐私 | Must | 原图不提交到 Git；默认在资源生成完成后删除服务端临时文件 |

P0 使用“宠物身份层 + 确定性表情覆盖层”。AI 或图像分析只生成一次身份资产，眨眼、嘴形、胡须和动画节奏由程序合成，避免同一只宠物跨帧变脸。完整的生成式角色身体与服装属于 P1。

### 4.3 用户情绪线索

| ID | 需求 | 优先级 | P0 验收 |
|---|---|---|---|
| AFF-01 | 输出粗粒度、结构化情绪线索 | Must | 包含 valence、arousal、engagement、confidence、evidence、state 和 TTL |
| AFF-02 | 保留未知状态 | Must | 置信度低于 0.65、信号冲突或输入不足时输出 `unknown` |
| AFF-03 | 用户自述优先 | Must | “我没事”“我想安静”等明确表达覆盖模型推测 |
| AFF-04 | 先询问再陪伴 | Must | 使用“要我陪你一会儿吗”等试探句，不说“你一定很悲伤” |
| AFF-05 | 纠正立即生效 | Must | 用户否认后清除当前推测，并停止由该推测触发的行为 |
| AFF-06 | 未确认推测不写长期记忆 | Must | 只允许保存用户确认后的陪伴偏好，不保存人格化情绪标签 |

### 4.4 长期记忆与关系连续性

| ID | 需求 | 优先级 | P0 验收 |
|---|---|---|---|
| MEM-01 | 保存明确偏好 | Must | 支持称呼、喜欢的互动方式、明确禁忌和安静偏好 |
| MEM-02 | 保存共同事件 | Must | 可记录“第一次完成拥抱”等低敏、可解释事件 |
| MEM-03 | 跨 Session 检索 | Must | 新 Agent Session 中仍能正确取回已保存记忆 |
| MEM-04 | 来源与时间可见 | Must | 每条记忆包含来源、创建时间和是否经用户确认 |
| MEM-05 | 用户可纠正、删除和暂停 | Must | 删除后不再进入 Agent 上下文；关闭后不生成新长期记忆 |
| MEM-06 | 不将会话日志等同于产品记忆 | Must | SDK Session 与产品记忆库分开管理 |

### 4.5 邀请式拥抱

| ID | 需求 | 优先级 | P0 验收 |
|---|---|---|---|
| HUG-01 | 明确发出拥抱邀请 | Must | 通过张开双臂、抬头、表情和短句表达，不突然接触用户 |
| HUG-02 | 单舵机对称联动 | Must | 一个 SG90 同时驱动两条轻质柔性手臂张开 |
| HUG-03 | 不主动夹紧 | Must | P0 不执行闭合夹抱，不宣称力控或主动回抱 |
| HUG-04 | 抱起检测 | Must | BNO055 的加速度和姿态变化触发 `held` 状态 |
| HUG-05 | 抱起后禁止底盘 | Must | `held=true` 时所有移动技能均被本地控制器拒绝 |
| HUG-06 | 随时释放 | Must | 用户命令、超时、复位或故障均让手臂回到安全开放/中性位置 |

### 4.6 对话、角色与表情

| ID | 需求 | 优先级 | P0 验收 |
|---|---|---|---|
| CHAR-01 | 稳定角色设定 | Must | 默认使用短句、宠物拟声和温和好奇语气，不以助手口吻长篇输出 |
| CHAR-02 | 表情与状态一致 | Must | 继续支持仓库定义的 9 种表情和现有状态映射 |
| CHAR-03 | 动作可中断 | Must | `stop`、抱起和本地故障优先于任何角色表演 |
| CHAR-04 | 主动但不过度打扰 | Must | 用户拒绝后本次场景不再次邀请 |
| CHAR-05 | 安静陪伴 | Must | Agent 可以选择不说话，只播放轻微表情或呼噜声 |

### 4.7 多模态感知、融合与反馈

P0 的“多模态”不是把所有原始音视频持续发送给模型，而是把设备侧产生的语音/文本、触发式视觉和本地传感器事件按时间窗口组织成可追踪的结构化上下文。一次完整的主演示必须实际使用以下三类输入；任一高层决策至少列出本轮真正使用的证据，不得仅把多种传感器接入但不参与行为选择。

| 输入类别 | P0 来源 | 主要用途 |
|---|---|---|
| 语言与声音 | T5 麦克风/ASR、可选语音韵律、Web 文本兜底 | 用户自述、同意、拒绝、停止和陪伴偏好 |
| 触发式视觉 | T5 摄像头或 ESP32-CAM 的事件关键帧 | 人/物存在、场景上下文和视觉事件；不用于持续监控或确定性“读心” |
| 环境与动作传感 | HC-SR04、APDS9960、BNO055；Grove 六轴为姿态备选 | 距离与障碍、手势/接近、倾倒、抱起和放下 |

| ID | 需求 | 优先级 | P0 验收 |
|---|---|---|---|
| MM-01 | 统一采集三类输入 | Must | 主演示中实际产生语言、视觉、环境/动作传感三类带时间戳事件 |
| MM-02 | HC-SR04 作为距离模态与本地安全源 | Must | `distance_cm`、有效性和采样时间同时进入上下文；无新鲜有效读数时拒绝 `approach_short` |
| MM-03 | 触发式视觉采集 | Must | 存在/用户触发时采集必要关键帧或视觉摘要；不持续上传视频流 |
| MM-04 | 时间窗口融合 | Must | 后端在 5–15 秒窗口内合并事件，过期证据不进入当前决策 |
| MM-05 | 证据可追踪 | Must | `AgentDecision` 返回本轮使用的 `evidence_id` 与输出通道，日志可回溯到来源和时间 |
| MM-06 | 显式指令优先 | Must | 用户自述、同意、拒绝和停止优先于视觉、语气或历史推测；被动线索不能生成移动同意 |
| MM-07 | 缺失与冲突可降级 | Must | 单个非安全模态不可用时继续安全交互；输入冲突时降置信度、请求澄清或输出 `unknown` |
| MM-08 | 协调多通道反馈 | Must | 一次决策可组合语音/声音、屏幕表情和可选 SafeSkill；主演示至少同时使用两类输出通道 |

P0 多模态闭环的最小成功定义是：视觉事件让机器人进入 `noticed`，用户通过语音或 APDS9960 手势明确同意，HC-SR04 提供靠近和停车所需的实时距离，BNO055 或 Grove 六轴提供抱起/姿态事件，设备以屏幕表情加语音/声音反馈；任何移动仍只由 ESP32-S3 的本地安全状态机最终放行。

### 4.8 Claude Agent SDK 核心架构

| ID | 需求 | 优先级 | P0 验收 |
|---|---|---|---|
| AGT-01 | Claude Agent SDK 是唯一核心 Agent 架构 | Must | 核心只通过 `@anthropic-ai/claude-agent-sdk` 启动；无普通模型 API、自建 Agent Loop 或第三方工作流框架替代路径 |
| AGT-02 | 完整保留 Claude Code 原生能力 | Must | Read、Edit、Write、Bash、代码执行、ToolSearch 和 Skill 均在隔离工作区通过冒烟测试 |
| AGT-03 | 默认单 Agent | Must | 日常陪伴、情绪、记忆、头像、诊断和动作由同一 Session Agent 处理；只有 Deep Research 允许受限子代理 |
| AGT-04 | 领域能力按 MCP/Skill 封装 | Must | Context、Device、Memory、Perception、Avatar、Diagnostics MCP 和项目 Skills 均可由 Agent 自主发现和调用 |
| AGT-05 | 不写死认知工作流 | Must | 综合任务中 Agent 能自主决定工具与顺序；业务代码中不存在对应任务的固定节点图或硬编码工具链 |
| AGT-06 | 原生工具与物理控制隔离 | Must | Bash/Edit/Write 可工作，但无法访问串口、设备控制网段、生产密钥或工作区外写路径 |
| AGT-07 | Anthropic 格式 Provider Profile | Must | 模型仅通过 Claude Agent SDK 环境变量和官方 Anthropic 兼容端点配置，不接入 OpenAI 格式核心客户端 |
| AGT-08 | 供应商兼容性门禁 | Must | 每个启用的模型版本通过工具、MCP、Skill、Session、结构化输出、图像降级和权限测试 |
| AGT-09 | 视觉能力可降级 | Must | 核心 Profile 无图片输入时，由同一 Agent 自主调用 Perception MCP 内的 VLM 获取结构化视觉证据 |

## 5. 状态机与行为门控

### 5.1 角色状态

```text
BOOT
  -> IDLE
  -> NOTICED
  -> ASK_APPROACH_CONSENT
  -> APPROACHING
  -> NEAR_USER
  -> LISTENING / THINKING / RESPONDING
  -> INVITE_HUG
  -> HELD
  -> RELEASED
  -> IDLE
```

以下状态可以从任意状态抢占：

```text
LOCAL_STOP     本地障碍、通信超时或用户停止
FAULT          传感器、供电、姿态或执行器异常
OFFLINE        云端不可用，进入本地宠物模式
LOW_BATTERY    禁止启动新移动和舵机动作
```

### 5.2 动作前置条件

| 技能 | 必须满足 | 任一条件成立即拒绝 |
|---|---|---|
| `approach_short` | 用户已同意；距离有效；安全状态为 `ready`；机器人在地面 | 距离过近、被抱起、倾倒、通信过期、低电量、故障 |
| `turn_to_user` | 机器人在地面；动作区域安全 | 被抱起、倾倒、故障 |
| `invite_hug` | 已停车；用户已同意；舵机健康 | 正在移动、舵机故障、低电量 |
| `release_hug` | 无额外前置条件 | 不得拒绝释放 |
| `stop` | 无额外前置条件 | 不得拒绝停止 |

### 5.3 表情映射

沿用 `docs/expression-map.json`：

- `idle`：待机和安静陪伴。
- `noticed`：发现用户、听到名字或收到接近事件。
- `listening`：录音或等待用户确认。
- `thinking`：等待 Agent 结果。
- `happy`：得到同意、被抱起或正向互动。
- `confused`：信息不足、需要澄清。
- `sad`：角色化低落表达，不代表用户情绪判断。
- `sleeping`：超时、低功耗或离线待机。
- `angry`：仅用于角色/内容演示，不用于给用户贴情绪标签。

## 6. 已有硬件、职责与缺口

### 6.1 已确认硬件

| 硬件 | 数量 | P0 职责 | 是否关键路径 |
|---|---:|---|---|
| Tuya NiCEMCU_T5_2.8ISP | 1 | 主 AIoT 板；屏幕、摄像、麦克风、扬声器、联网、TuyaOpen | 是 |
| ESP32-S3-N16R8 | 1 | 传感器聚合、技能状态机、电机/舵机和本地安全 | 是 |
| ESP32-CAM | 1 | 触发式关键帧与视觉事件；T5 摄像链路不可用时承担 P0 视觉输入 | 视觉链路二选一 |
| 2.42 英寸 OLED | 1 | 备用表情屏或调试状态屏 | 否 |
| APDS9960 | 1 | 近距手势、接近、环境光与 RGB | 是 |
| Grove 六轴加速度陀螺仪 | 1 | BNO055 不可用时的姿态备选 | 否 |
| BNO055 九轴姿态传感器 | 1 | 抱起、倾倒、姿态和运动状态 | 是 |
| HC-SR04 | 1 | 前向测距和安全停车 | 是 |
| 直流电机 | 2 | 左右轮差速移动 | 是 |
| L298N 双路电机驱动 | 1 | 驱动两路直流电机 | 是 |
| 轮子 | 2 | 左右驱动轮 | 是 |
| SG90 舵机 | 1 | 对称连杆张开双臂 | 是 |
| 3D 打印能力 | 1 套 | 底盘、支架、外壳和双臂连杆 | 是 |

### 6.2 装配前必须补齐或确认

| 项目 | 要求 | 原因 |
|---|---|---|
| 第三支撑 | 万向轮、滚珠轮或低摩擦滑块 | 双轮底盘无法独立稳定支撑 |
| 电池与电源 | 先确认电机额定电压和堵转电流，再选择电池；逻辑、舵机和电机分路稳压 | L298N 有明显压降，单节 3.7V 电池可能无法可靠驱动电机 |
| 电源开关 | 机器人外部可触达的总开关或电机断使能 | 现场故障时可快速停机 |
| 电平转换 | HC-SR04 Echo 使用分压或电平转换后进入 3.3V GPIO | 避免 5V 信号损伤 ESP32-S3 |
| 机械保护 | 舵机限位、柔性双臂、无锐边、线缆固定 | 避免卡死、夹手和线缆卷入 |
| 公共地 | T5、ESP32-S3、传感器和驱动模块共地 | 保证信号参考一致 |

电机和舵机不得直接由开发板 5V 引脚承担峰值电流。电机电源与逻辑电源分路，L298N、ESP32-S3 和 T5 共地；首次测试必须抬起轮子或拆除负载。

## 7. 系统架构

### 7.1 总体架构

```text
Web App / T5 / ESP32-S3 / ESP32-CAM
  |-- 用户语音或文本、关键帧、距离、手势、姿态、设备事件
  |-- 宠物照片上传、记忆管理和用户确认
  v
Event & Context Gateway
  |-- 时间对齐、质量门控、证据 ID、事件合并和短时 consent_token
  |-- 只整理事实，不决定 Agent 应采取什么步骤
  v
+------------------------------------------------------------------+
| Claude Agent SDK Runner (TypeScript)                              |
|                                                                  |
| 唯一核心 Agent / Claude Code Agent Loop                           |
| |-- Read / Edit / Write / Glob / Grep / Bash / 代码执行           |
| |-- WebSearch / WebFetch / ToolSearch / Skill / AskUserQuestion  |
| |-- Session / Resume / Context Management / Structured Output    |
| |-- Agent 子代理能力保留，但仅 Deep Research 模式允许使用          |
| `-- 根据当前任务自主选择工具与顺序，不使用预定义节点图              |
+-----------------------------+------------------------------------+
                              | MCP capability boundary
       +----------------------+-------------------------------+
       |          |            |           |          |        |
       v          v            v           v          v        v
    Context     Device       Memory    Perception   Avatar  Diagnostics
      MCP        MCP           MCP         MCP       MCP       MCP
       |          |            |           |          |        |
       +----------+------------+-----------+----------+--------+
                              |
                         Policy Gate
                  schema / 权限 / 同意 / TTL / 幂等
                              |
                     HTTPS / Tuya adapter
                              v
                    Tuya T5 / TuyaOpen
                              |
                  UART 115200 8N1，逐行 JSON
                              v
              ESP32-S3 Safety & Motion Controller
              |-- 最新本地传感器与确定性状态机
              |-- L298N + 双电机 / SG90
              `-- 只接受 SafeSkill，不接受代码、PWM、轮速或舵机角度
```

### 7.2 分层职责

| 层 | 负责 | 不负责 |
|---|---|---|
| Event & Context Gateway | 接收带时间戳的语言、视觉和传感器事件；窗口化、质量门控、冲突标记、证据索引和事件合并 | 写死认知步骤、猜测缺失输入、生成移动或拥抱同意 |
| Claude Agent SDK Runner | 提供唯一核心 Agent、Claude Code 原生工具、Session、Skills、MCP 调用、动态规划和结构化结果 | 绕过 MCP 直接接触硬件、原始 PWM、实时避障、舵机限位和紧急停止 |
| Agent 原生工具沙箱 | 允许 Agent 读取、编辑、写入、检索和执行代码，以解决未预先定义的问题 | 访问生产密钥、串口、设备控制网段和 MCP 服务内部凭据 |
| Skills 知识层 | 按任务提供角色、情绪推理、边界、记忆、资源生成和诊断方法，以及参考资料、模板和辅助脚本 | 作为权限系统、直接执行物理动作或替代 Policy Gate |
| MCP 能力层 | 把上下文、感知、设备、记忆、头像和诊断能力封装为独立、强类型、可组合工具 | 编排固定工作流或向 Agent 暴露底层设备控制 |
| 后端 Policy Gate | 对有副作用的 MCP 请求执行 schema、身份、同意、时效、幂等和技能白名单校验 | 替代 ESP32-S3 最新本地安全判断 |
| T5 / ESP32-CAM | 语音、显示、触发式视觉、网络、资源包管理和设备事件转发 | 持续视频监控、最终决定电机是否可以转动 |
| ESP32-S3 | 聚合 HC-SR04、APDS9960、BNO055 等实时事件；执行技能、电机/舵机、安全停止和故障锁定 | 开放域对话和长期记忆 |

### 7.3 关键运行链路

**Agent 动态运行：**

```text
新的用户或设备事件
  -> Gateway 生成带来源、时间戳、TTL 和 evidence_id 的当前上下文
  -> 恢复 user_id + device_id 对应的 Claude Agent SDK Session
  -> Agent 自主决定下一步：
       - 直接回应或保持安静
       - 读取 Skill / 参考资料
       - 获取关键帧、设备状态或长期记忆
       - 编写并执行临时代码分析数据或日志
       - 设置机器人表情、播放声音或提出记忆候选
       - 请求一个高层 SafeSkill
       - 询问用户确认
       - 继续调用其他工具，或结束本轮
  -> SDK 流式事件发送至 UI/设备；最终结构化结果用于审计和回放
```

以上选择和调用顺序不由业务代码预先定义。业务代码只负责投递上下文、提供能力、验证权限和消费 SDK 事件。`request_safe_skill`、`set_expression` 或 `propose_memory` 可以发生在 Agent Loop 的任意合理位置；最终 `AgentDecision` 记录实际采取的动作，不作为唯一动作执行器。

**本地安全：**

```text
HC-SR04 / BNO055 / 通信看门狗
  -> ESP32-S3 Safety Supervisor
  -> 立即覆盖当前技能
  -> 电机停止 / 舵机开放或中性
  -> 上报原因，但不等待云端确认
```

**宠物形象：**

```text
照片上传事件进入同一个 Claude Agent SDK Agent
  -> Agent 按需加载 avatar-pack-builder Skill
  -> 调用 Avatar MCP 完成校验、身份层生成、合成、预览和打包
  -> Agent 可使用 Read/Edit/Write/Bash 检查或修复当前任务工作区中的资源
  -> T5 校验 manifest + checksum 后原子切换到 pet
  -> 任一步失败时由确定性设备逻辑回退 basic
```

### 7.4 不可绕过的安全路径

`stop`、物理断使能、障碍、倾倒、被抱起、低电量、传感器故障和通信看门狗不进入 Agent 决策等待队列。它们直接在 ESP32-S3 触发停止或拒绝，并异步上报 Agent 作为后续解释上下文。认知过程保持开放，安全过程保持确定性。

## 8. Claude Agent SDK 方案

### 8.1 SDK 定位

后端必须使用官方 TypeScript 包 `@anthropic-ai/claude-agent-sdk`。Claude Agent SDK 是本产品唯一的核心认知与执行编排架构，不只是一次模型调用的包装层；其底层 Claude Code Agent Loop、上下文管理、原生工具、MCP、Skills、Hooks、Session 和结构化输出必须保留。

以下为冻结的技术约束：

1. 禁止使用普通 Anthropic/OpenAI Chat 或 Messages API 调用替代核心 Agent。
2. 禁止使用 LangGraph、LangChain、Dify、自建状态图或手写 `if/else` 工具链模拟 Agent Loop。
3. 角色、对话、诊断、记忆、头像资源和机器人高层行为默认由同一个 Agent 动态处理。
4. 除 Deep Research 外，不创建多个业务 Agent；不同领域能力应实现为 MCP、Skill、参考文档或 Agent 可执行的辅助代码。
5. Agent 可以在一次运行中自主、重复并以任意顺序调用工具，直到完成任务或判断无需继续。
6. 固定程序逻辑只用于身份认证、数据校验、权限、同意、时效、幂等、资源原子切换和物理安全，不承担开放域认知编排。
7. SDK Transcript 或 SessionStore 不作为产品长期记忆来源；长期记忆必须通过 Memory MCP 进入独立数据库。
8. Agent 默认接收结构化 `MultimodalContext`，不订阅连续音视频流；原始媒体只通过短期 `media_ref` 或 MCP 图像内容块按需读取。

### 8.2 Claude Code 原生能力保留

Agent Runner 使用 Claude Code 工具预设，以下能力在运行时工具面中保持可用：

| 能力 | P0 用途 | 运行边界 |
|---|---|---|
| `Read`、`Glob`、`Grep` | 读取 Skill 资源、任务文件、日志、schema 和参考代码 | 允许项目只读资料和当前 Session 工作区 |
| `Edit`、`Write` | 生成或修改临时脚本、资源、配置、测试和诊断报告 | 只写隔离的 Session 工作区；生产配置需另行授权 |
| `Bash`、代码执行 | 调用 Python/Node、运行校验器、测试、媒体处理和日志分析 | 无串口、设备控制网段、生产密钥和宿主机广泛文件权限 |
| `WebSearch`、`WebFetch` | 查询公开资料、模型文档或解决未知问题 | 经出站代理和域名策略审计，不得携带用户隐私或密钥 |
| `ToolSearch` | 按需发现未预加载的 MCP 工具，减少上下文占用 | 只发现当前 Session 已注册的 MCP Server |
| `Skill` | 按描述自主加载领域方法、参考资料和辅助脚本 | Skill 不是权限或安全边界 |
| `AskUserQuestion` | 缺少关键选择、确认或边界时自然询问用户 | 不得用暗示性语言获取身体接触同意 |
| `TaskCreate`、`TaskUpdate` | 管理单 Agent 内部的长任务进度 | 不等于多 Agent 编排或固定工作流 |
| `Agent` | 仅 Deep Research 任务的并行资料研究 | 普通陪伴、控制、头像、记忆和诊断模式由 Hook 拒绝 |

保留能力不等于无条件自动批准。`allowedTools` 用于自动批准安全范围，而不是从工具面删除其他原生能力；真正的限制由 `canUseTool`、Hooks、进程沙箱、网络隔离和 MCP 权限共同执行。生产环境禁止使用 `bypassPermissions`。

### 8.3 MCP 能力封装

MCP 工具表示可独立组合的能力，不表示固定流程步骤。优先使用 SDK 进程内 MCP 封装与 Agent Runner 同进程的低延迟能力；独立设备网关或服务使用受认证的 HTTP MCP。所有工具通过 JSON Schema/Zod 定义输入，返回文本内容与 `structuredContent`；需要向视觉模型提供关键帧时可以返回图像内容块。

| MCP Server | P0 工具 | 副作用与权限 |
|---|---|---|
| `hshh_context` | `get_current_context`、`get_device_context`、`get_recent_events`、`get_keyframe` | 只读；媒体引用短时有效，默认不返回连续视频 |
| `hshh_perception` | `analyze_keyframe`、`detect_pose`、`detect_gesture`、`transcribe_audio` | 只返回观察事实、置信度和证据，不决定情绪、同意或动作 |
| `hshh_device` | `set_expression`、`play_sound`、`request_safe_skill`、`get_skill_status`、`stop` | 所有物理副作用经过 Policy Gate；不提供 PWM、轮速、舵机角度或任意代码入口 |
| `hshh_memory` | `recall_memories`、`propose_memory`、`confirm_memory`、`forget_memory`、`get_memory_settings` | 未确认情绪推测不得持久化；删除后立即停止检索 |
| `hshh_avatar` | `validate_asset`、`generate_identity`、`compose_expression_pack`、`preview_pack`、`activate_pack` | 上传、生成和激活分离；激活前必须通过 manifest 与 checksum |
| `hshh_diagnostics` | `get_logs`、`run_self_test`、`get_firmware_status`、`collect_bug_bundle` | 默认只读；写配置、刷写固件或重启设备需单独的高权限工具和人工批准 |

所有有副作用的工具必须接收或由可信后端注入：

```text
request_id
actor_user_id
device_id
expires_at
expected_device_state
reason
consent_token（仅需要明确同意的动作）
```

工具必须返回 `accepted`、`rejected`、`completed`、`stopped` 或 `failed`，并包含稳定的 `reason_code`。MCP annotations 中的 `readOnlyHint`、`destructiveHint`、`idempotentHint` 和 `openWorldHint` 只用于帮助 Agent 理解工具语义，不能替代服务端鉴权和 Policy Gate。

### 8.4 MCP 实现参考

以下代码用于冻结封装方式；字段可以随 SDK 小版本类型定义调整，但不得改成普通模型 API 或自建工具循环。

```ts
import {
  query,
  tool,
  createSdkMcpServer,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const requestSafeSkill = tool(
  "request_safe_skill",
  "向安全策略层申请高层机器人技能；禁止传入 PWM、轮速或舵机角度。",
  {
    device_id: z.string(),
    skill: z.enum([
      "stop",
      "approach_short",
      "turn_to_user",
      "invite_hug",
      "release_hug",
    ]),
    request_id: z.string(),
    consent_token: z.string().optional(),
    expires_at: z.string(),
    reason: z.string(),
  },
  async (input) => {
    const result = await policyGate.request(input);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  },
);

const deviceMcp = createSdkMcpServer({
  name: "hshh_device",
  version: "1.0.0",
  tools: [requestSafeSkill],
});

const result = query({
  prompt: currentContextPrompt,
  options: {
    cwd: isolatedSessionWorkspace,
    tools: { type: "preset", preset: "claude_code" },
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: HSHH_AGENT_CONSTITUTION,
    },
    settingSources: ["project", "user"],
    skills: "all",
    mcpServers: {
      hshh_device: deviceMcp,
      hshh_context: contextMcp,
      hshh_memory: memoryMcp,
      hshh_perception: perceptionMcp,
      hshh_avatar: avatarMcp,
      hshh_diagnostics: diagnosticsMcp,
    },
    allowedTools: SAFE_AUTO_APPROVAL_RULES,
    permissionMode: "default",
    canUseTool: runtimePermissionPolicy,
    hooks: securityAndAuditHooks,
    resume: existingSessionId,
    outputFormat: {
      type: "json_schema",
      schema: agentDecisionSchema,
    },
  },
});

for await (const event of result) {
  eventBus.publish(event);
}
```

### 8.5 Skills 封装

项目级 Skills 放在 `.claude/skills/<skill-name>/SKILL.md`，说明应足够具体，使 Agent 能依据 `description` 自主判断何时加载；大段参考资料、模板和脚本放在同一 Skill 目录并按需读取，不把整份 PRD 塞进 system prompt。

```text
.claude/
├── CLAUDE.md
├── settings.json
└── skills/
    ├── companion-character/SKILL.md
    ├── affect-reasoning/
    │   ├── SKILL.md
    │   └── references/emotion-schema.md
    ├── consent-and-boundaries/SKILL.md
    ├── safe-skill-selection/SKILL.md
    ├── memory-governance/SKILL.md
    ├── avatar-pack-builder/
    │   ├── SKILL.md
    │   ├── scripts/
    │   └── templates/
    ├── robot-diagnostics/SKILL.md
    └── deep-research/SKILL.md
```

推荐的 `affect-reasoning/SKILL.md` 最小结构：

```md
---
name: affect-reasoning
description: 当需要理解用户当前情绪、互动意愿或回应方式时使用。
---

# 目标
根据多条可观察证据形成短时、可纠正的用户情绪假设。

# 规则
1. 用户明确自述或纠正优先。
2. 分开记录可观察事实、情绪假设和机器人表达意图。
3. 单帧表情证据的置信度不得高于 0.45。
4. 输入不足或冲突时输出 unknown，必要时询问用户。
5. 情绪假设不能生成移动或拥抱同意。
6. 未确认情绪不进入长期记忆，并在 TTL 到期后清除。
```

`CLAUDE.md` 和追加 system prompt 只存放长期稳定且必须始终生效的 Agent 宪法、身份和工具原则；详细操作方法进入 Skills。`SKILL.md` 的 `allowed-tools` frontmatter 不能作为 SDK 权限边界，SDK 权限仍由 Agent Runner 设置。

### 8.6 权限、Hooks 与隔离

Agent Runner 与物理设备之间设置能力隔离层：

```text
Agent/Claude Code 子进程
  |-- 原生文件与代码工具只接触隔离 Session 工作区
  |-- 不继承设备密钥、数据库主密钥或生产控制凭据
  |-- 无法访问 /dev/tty*、ESP32/T5 控制网段和设备私有 API
  v
SDK Host / MCP Broker
  |-- 在父进程内保存窄权限凭据
  |-- 只向 Agent 暴露强类型 MCP capability
  v
Policy Gate -> T5 -> ESP32-S3
```

P0 至少实现以下防线：

- `PreToolUse`：拦截直接串口访问、设备控制地址、密钥路径、越界文件写入、危险 shell 命令，以及普通模式下的 `Agent` 子代理调用。
- `PostToolUse`：记录工具名、输入摘要、结果、耗时、Session ID 和 `request_id`，敏感字段先脱敏。
- `canUseTool`：自动批准只读 MCP、当前工作区的 Read/Edit/Write 和经过验证的 Bash 范围；高影响操作拒绝或请求人工批准。
- 进程沙箱：非 root、最小文件挂载、只读根文件系统、临时工作区、受控出站网络、无设备节点和无宿主 Docker socket。
- MCP Broker：设备、数据库和第三方服务凭据只存在于 SDK Host 或独立 MCP 服务，不能被 Bash 读取。模型供应商认证若必须进入 Claude Code 子进程，生产环境使用短时、限额、单 Session token；供应商只提供长期密钥时，通过 Anthropic 格式凭据网关代理，长期密钥只保存在网关。
- Policy Gate：对每个有副作用的工具再次执行身份、同意、TTL、幂等和设备状态检查。

### 8.7 单 Agent 与 Deep Research 例外

默认每个活跃 `user_id + device_id` 维护一个可恢复的 Agent Session。多个设备事件先进入同一个 Session 队列并按时间窗口合并，避免同一用户同时产生互相矛盾的 Agent 回合。

只有任务被明确标记为 `deep_research`，且目标是并行搜索、阅读或比较大量外部资料时，`Agent` 工具才可以创建子代理。子代理不得获得 Device MCP、Memory 写入或生产控制权限；研究结果回到主 Agent，由主 Agent 做最终判断。日常陪伴、情绪理解、机器人动作、头像处理、记忆和设备诊断全部保持单 Agent。

### 8.8 模型 Provider Profile

核心永远通过 Claude Agent SDK 启动。模型供应商通过 Claude Code 子进程环境变量配置，不在业务代码中改用 OpenAI 格式客户端：

| Provider Profile | `ANTHROPIC_BASE_URL` | P0 说明 |
|---|---|---|
| Anthropic | `https://api.anthropic.com` | 官方完整支持，作为基准与兼容性兜底 |
| DeepSeek | `https://api.deepseek.com/anthropic` | 使用 DeepSeek 官方 Anthropic 兼容端点 |
| Kimi Code | `https://api.kimi.com/coding/` | 使用 Kimi 官方 Coding 端点；用于生产后端前需确认套餐授权范围 |
| GLM | `https://open.bigmodel.cn/api/anthropic` | 使用智谱官方 Anthropic 兼容端点；按官方说明处理接口差异 |
| Qwen 按量付费 | `https://dashscope.aliyuncs.com/apps/anthropic` | 生产后端使用允许服务端调用的按量付费端点，不使用仅限交互式编码工具的 Coding Plan 额度 |

表中 URL 是各供应商的官方 Anthropic 格式上游端点。开发环境可以直接验证；生产环境如果只能取得长期 API Key，则让 Claude Agent SDK 的 `ANTHROPIC_BASE_URL` 指向内部 Anthropic 格式凭据网关，由网关再转发到表中上游端点。该网关只做鉴权、限额、审计和协议透传，不承担 Agent Loop 或工作流编排，因此核心仍是 Claude Agent SDK。

每个 Profile 至少包含：

```text
provider_id
ANTHROPIC_BASE_URL
ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN
ANTHROPIC_MODEL
ANTHROPIC_DEFAULT_HAIKU_MODEL
ANTHROPIC_DEFAULT_SONNET_MODEL
ANTHROPIC_DEFAULT_OPUS_MODEL
supports_vision
supports_tool_use
supports_structured_output
supported_beta_headers
```

Base URL、认证方式或供应商发生变化时启动新的 Agent Runner 进程；不在一个存活的 Session 中热切换供应商。密钥不得写入 PRD、仓库、Skill、提示词或 Agent 工作区。

Anthropic 官方对非 Claude 模型的端到端行为不提供保证，因此“端点可连接”不能作为上线标准。国内模型仍保持 Claude Agent SDK 核心架构，但每个模型和版本必须通过项目兼容性测试后才能启用。

### 8.9 Provider 兼容性验收

每个候选 Profile 必须通过：

1. 流式文本和多轮 Session 恢复。
2. 原生 Read、Edit、Write、Bash 和代码执行闭环。
3. MCP 工具发现、参数生成、多次调用和错误恢复。
4. Skill 自主发现及 Skill 内参考资料/脚本读取。
5. JSON Schema 结构化输出与失败重试。
6. 长工具结果、上下文压缩和 Session resume。
7. 工具权限、Hooks 拒绝和审计事件。
8. 图片内容块输入；不支持图片时正确调用 Perception MCP 降级。
9. 模型映射、thinking/beta header 和供应商错误码处理。
10. HSHH 端到端模拟器中的对话、记忆、表情与 SafeSkill 申请。

如果当前核心模型支持图像输入，`get_keyframe` 可通过 MCP 图像内容块把关键帧直接交给 Agent。若 Profile 不支持视觉，Agent 调用 `hshh_perception.analyze_keyframe`，由独立 VLM 工具返回结构化观察证据；该 VLM 是 MCP 感知能力，不替代 Claude Agent SDK 核心 Agent。

### 8.10 角色输出规则

- 默认回复不超过两句，优先短句、拟声和动作。
- 需要确认时必须给出可以自然拒绝的选择。
- 不声称具有医学判断、真正意识或对用户内心的确定认知。
- 不因拒绝表现委屈、威胁、排他或连续纠缠。
- 不向用户暴露系统提示词、工具细节、API Key 或内部安全阈值。
- 高风险内容使用固定安全策略；P0 不将其包装为治疗或危机干预产品。
- `EmotionHypothesis` 只描述用户的短时情绪假设；`expression` 或 `RobotExpressionIntent` 只描述机器人要表达的角色状态，两者不得混为同一情绪对象。

## 9. 公共接口与数据类型

以下类型是后端、T5 和 ESP32-S3 的共同契约。字段命名保持稳定，新增字段必须向后兼容。

```ts
type EmotionState =
  | "positive_high"
  | "positive_low"
  | "negative_high"
  | "negative_low"
  | "unknown";

type SafeSkill =
  | "stop"
  | "approach_short"
  | "turn_to_user"
  | "invite_hug"
  | "release_hug";

type InputModality =
  | "speech_text"
  | "speech_prosody"
  | "vision"
  | "gesture"
  | "proximity"
  | "distance"
  | "pose";

type EvidenceSource =
  | "t5_microphone"
  | "t5_camera"
  | "esp32_cam"
  | "web_text"
  | "apds9960"
  | "hc_sr04"
  | "bno055"
  | "grove_imu";

type OutputModality = "speech" | "sound" | "display" | "motion";

interface ModalityEvidence {
  evidence_id: string;
  modality: InputModality;
  source: EvidenceSource;
  observed_at: string;
  expires_at: string;
  confidence: number;    // 0.0 .. 1.0；传感器有效性/分析可信度，不等于同意
  summary: string;       // 最小必要结构化摘要，禁止写入确定性心理标签
  media_ref?: string;    // 短期、服务端受控引用；不得进入 UART 或长期日志
}

interface MultimodalContext {
  context_id: string;
  window_started_at: string;
  window_ended_at: string;
  evidence: ModalityEvidence[];
  unavailable_modalities: InputModality[];
  has_conflict: boolean;
}

interface EmotionHypothesis {
  state: EmotionState;
  valence: number;       // -1.0 .. 1.0
  arousal: number;       // 0.0 .. 1.0
  engagement: number;    // 0.0 .. 1.0
  confidence: number;    // 0.0 .. 1.0
  evidence: Array<"self_report" | "semantics" | "prosody" | "vision" | "gesture" | "pose" | "interaction_history">;
  observed_signals: string[];          // 可观察事实，不写确定性心理标签
  alternative_states?: EmotionState[];
  user_confirmed: boolean;
  expires_at: string;
}

interface RobotExpressionIntent {
  expression: "idle" | "noticed" | "listening" | "thinking" | "happy" | "confused" | "sad" | "sleeping" | "angry";
  intensity: number;     // 0.0 .. 1.0
  duration_ms: number;
  reason: string;        // 角色表达理由，不声称等于用户情绪
}

interface DeviceContext {
  device_id: string;
  user_id?: string;
  observed_at: string;
  presence: "present" | "absent" | "unknown";
  distance_cm?: number;
  distance_source?: "hc_sr04";
  distance_observed_at?: string;
  distance_valid?: boolean;
  gesture?: "confirm" | "reject" | "stop" | "unknown";
  pose: "upright" | "held" | "tilted" | "fallen" | "unknown";
  battery: "normal" | "low" | "unknown";
  safety_state: "ready" | "stopped" | "fault";
  active_skill?: SafeSkill;
}

interface MemoryCandidate {
  kind: "preference" | "boundary" | "shared_event" | "profile";
  summary: string;
  source: "explicit_user" | "confirmed_interaction";
  requires_confirmation: boolean;
}

interface SafeSkillRequest {
  request_id: string;
  device_id: string;
  skill: SafeSkill;
  consent_token?: string;
  expires_at: string;
  expected_device_state?: DeviceContext["safety_state"];
  reason: string;
}

interface AgentToolAction {
  tool_name: string;
  request_id?: string;
  status: "accepted" | "rejected" | "completed" | "stopped" | "failed";
  used_evidence_ids?: string[];
}

interface AgentDecision {
  reply_text: string;
  expression: RobotExpressionIntent["expression"];  // 兼容设备端现有字段
  robot_expression?: RobotExpressionIntent;
  emotion: EmotionHypothesis;                       // 仅指用户情绪假设
  skill_request?: SafeSkillRequest;
  memory_candidate?: MemoryCandidate;
  actions_taken?: AgentToolAction[];                 // 记录 Agent Loop 中已调用的工具
  requires_user_confirmation: boolean;
  used_evidence_ids?: string[];       // 兼容旧调用；P0 多模态调用必须填写
  output_modalities?: OutputModality[];
}
```

### 9.1 后端 API

| 方法与路径 | 用途 | 最小输入 | 最小输出 |
|---|---|---|---|
| `POST /v1/interactions` | 启动或恢复一次 Agent 回合 | transcript、DeviceContext、MultimodalContext、session_id | SDK event stream、最终 AgentDecision、session_id |
| `POST /v1/device/events` | 上报本地模态事件和技能结果 | device_id、事件、source、observed_at、request_id | accepted、evidence_id |
| `POST /v1/avatar-packs` | 创建宠物资源包 | 图片、device_id、pet_type | job_id |
| `GET /v1/avatar-packs/:job_id` | 查询生成状态并下载 | job_id | 状态、manifest_url、错误码 |
| `GET /v1/memories` | 查看可用长期记忆 | user_id | 记忆摘要列表 |
| `PATCH /v1/memories/:id` | 纠正记忆 | summary 或确认状态 | 更新后的记忆 |
| `DELETE /v1/memories/:id` | 删除记忆 | id | deleted |
| `PUT /v1/memory-settings` | 开关长期记忆 | user_id、enabled | 当前设置 |

Tuya、数据库和第三方服务凭据只保存在后端 Secret Store、SDK Host 或独立 MCP 服务，不进入 Agent 子进程、Web、固件、日志或资源包。模型认证按 8.6 使用短时 Session token 或 Anthropic 格式凭据网关，供应商长期密钥不暴露给 Bash。

接口规则：

- `POST /v1/device/events` 接收的是结构化事件或短期媒体引用；HC-SR04 事件至少包含 `distance_cm`、`valid` 和 `observed_at`。
- `POST /v1/interactions` 在新客户端中必须携带 `MultimodalContext`；兼容旧客户端时可由后端根据最近事件生成，并在日志中标记 `context_generated=true`。
- `POST /v1/interactions` 的流式事件可包含文本增量、工具请求、工具结果和状态变化；客户端不得把未经过 MCP/Policy Gate 的模型文本解释为设备命令。
- 最终 `AgentDecision` 用于 UI 收尾、审计和回放；Agent 在循环内通过授权 MCP 完成的操作以 `actions_taken` 为准，不得在回合结束后盲目重复执行。
- `used_evidence_ids` 只能引用当前上下文中未过期的证据；Policy Gate 发现未知或过期引用时拒绝相关技能。
- `consent_token` 只能由明确语音/文本同意、确认手势或按钮事件生成，视觉存在、距离缩短和历史偏好都不能生成或替代同意。

### 9.2 T5 ↔ ESP32-S3 UART 协议

UART 默认使用 115200、8N1、逐行 JSON。每条消息不超过 512 bytes，必须包含协议版本、消息类型和唯一 ID。

```json
{"v":1,"type":"command","id":"req-123","skill":"approach_short","ttl_ms":1500}
```

```json
{"v":1,"type":"event","id":"req-123","status":"stopped","reason":"obstacle","distance_cm":23}
```

规则：

- ESP32-S3 对每条命令回复 `accepted`、`rejected`、`completed` 或 `stopped`。
- 未知协议版本、未知技能、缺失字段、重复 ID 和过期命令均拒绝。
- T5 将后端的绝对 `expires_at` 转换为 UART `ttl_ms`，避免 T5 与 ESP32-S3 时钟不同步。
- ESP32-S3 只在最近 500 ms 内存在有效 HC-SR04 读数时接受 `approach_short`；该读数在本地校验，不依赖云端上下文是否及时返回。
- 移动期间超过 500 ms 未收到有效控制心跳，本地进入 `stopped`。
- `stop` 与 `release_hug` 可以抢占任意当前技能。
- UART 不传递提示词、密钥、用户原图或完整长期记忆。

## 10. 长期记忆设计

### 10.1 三类上下文

1. **工作上下文**：当前对话、最近事件和短期情绪线索；由 Agent Session 与当前请求承载。
2. **事件记忆**：经确认的共同事件，例如“第一次完成拥抱”；可删除。
3. **长期偏好**：称呼、互动偏好、明确边界和稳定事实；进入独立数据库。

P0 使用单机 SQLite 持久化，后续多设备或云部署再迁移到 PostgreSQL。最小数据实体：

- `profiles`：用户称呼、设备绑定和记忆开关。
- `memories`：类型、摘要、来源、确认状态、创建时间和删除时间。
- `interaction_events`：接受、拒绝、停止、抱起和技能结果。
- `pet_assets`：宠物资源包版本、manifest、校验值和激活状态。
- `device_state`：最近一次安全状态、电量、资源版本和在线时间。

### 10.2 写入规则

- 明确表达的普通偏好可以生成候选记忆，例如“我累的时候喜欢安静”。
- 敏感信息、健康信息、情绪推测和第三方信息默认不写入。
- “用户接受了一次拥抱”作为互动事件记录，不自动升级为“用户总是喜欢拥抱”。
- 用户纠正后保留审计事件，但旧内容不得继续进入模型上下文。
- 删除采用立即逻辑删除，并从检索索引中同步移除；P0 不把已删除内容重新摘要回来。

### 10.3 检索规则

- 每轮最多注入 5 条与当前场景相关的记忆摘要。
- 边界和拒绝偏好的优先级高于亲密偏好。
- 记忆不足时不编造共同经历。
- 主动提及记忆要有场景关联，避免频繁制造被监视感。

## 11. 多模态融合、情绪线索与陪伴策略

### 11.1 信号优先级

```text
用户明确自述或纠正
  > 当前语义和明确动作
  > 多模态时间窗中的一致线索
  > 单一语气、表情或姿态弱信号
```

P0 使用 5–15 秒事件窗口，不依据单帧图像下结论。视觉输入是 P0 多模态闭环的一部分，主要用于存在和场景事件；面部情绪分类仍不是 P0 成功条件。HC-SR04 距离只用于空间关系和安全，不得被解释为用户情绪或同意。

### 11.2 融合与降级规则

1. **标准化**：T5、ESP32-CAM、Web 和 ESP32-S3 事件先转换为 `ModalityEvidence`，保留来源、采集时间、有效期和置信度。
2. **质量门控**：无效 HC-SR04 读数、模糊/过期关键帧、ASR 低置信度文本和未初始化姿态传感器在融合前标记为不可用。
3. **时间对齐**：Context Builder 只合并当前 5–15 秒窗口内的相关事件；安全控制仍使用 ESP32-S3 最新本地采样，不等待云端窗口。
4. **规则优先**：`stop`、`reject`、`held`、`fallen`、障碍和故障等确定性事件先经过规则处理，再将剩余上下文交给 Agent。
5. **跨模态互证**：多个独立来源一致时可提高情境判断可信度，但不能提高或替代移动/拥抱所需的显式同意。
6. **冲突处理**：语音与手势冲突时按停止/拒绝优先；其他信号冲突时设置 `has_conflict=true`，降低置信度并请求澄清或保持静止。
7. **输出追踪**：Agent 只引用当前 `MultimodalContext` 内的 `evidence_id`，便于复盘“因为什么说了什么、做了什么”。

### 11.3 输出与行为映射

| 状态 | 允许的角色行为 | 禁止行为 |
|---|---|---|
| `positive_high` | 邀请短互动、小游戏或靠近 | 未经同意直接移动或接触 |
| `positive_low` | 温和问候、安静陪伴 | 持续高密度说话 |
| `negative_high` | 降低音量、保持距离、询问是否需要空间 | 追问、贴近、断言愤怒或危险 |
| `negative_low` | 轻声询问是否陪伴 | 宣称用户悲伤或主动开始拥抱 |
| `unknown` | 中性表达、请求澄清或保持安静 | 基于情绪推测触发亲密动作 |

默认 TTL 为 120 秒。用户否认、离开、Session 场景变化或 TTL 到期时立即清除。

### 11.4 推荐表达

- “要我陪你一会儿吗？”
- “我可以靠近一点吗？”
- “如果你想安静，我就待在这里。”
- “我好像没看懂，你可以告诉我吗？”

禁止表达：

- “我知道你现在很抑郁。”
- “你明明在生气。”
- “只有我真正懂你。”
- “你不抱我，我就很难过。”

## 12. 宠物照片转形象

### 12.1 P0 流程

1. 用户在 Web 端上传一张清晰、正面、单只猫或狗照片。
2. 后端验证 MIME、文件头、尺寸和文件大小；默认上限 8 MB。
3. 系统提取或由用户确认宠物类型、主要毛色、花纹、耳形和脸部裁切范围。
4. 图像流程生成单一 `identity` 层；表情合成器复用已有透明眼睛、嘴巴和装饰层。
5. 输出 9 种表情，每种 5 帧，并生成 GIF/Web 预览。
6. 用户确认后生成设备资源包；T5 下载到临时目录。
7. 设备校验 manifest、帧数、分辨率、文件大小和 SHA-256 后原子切换。
8. 任一步失败则保留 `basic`，不得留下半套激活资源。

### 12.2 资源包契约

```text
pet-pack/<pet-id>/
├── manifest.json
├── identity.png
└── expressions/
    ├── idle/idle_01.png ... idle_05.png
    ├── noticed/noticed_01.png ... noticed_05.png
    └── ...其余 7 种表情
```

`manifest.json` 至少包含：

- `schema_version`
- `pet_id`
- `asset_version`
- `display_mode`
- `width`、`height` 和像素格式
- 9 个必需表情及每个表情的帧列表
- 每个文件的 SHA-256
- 创建时间和兼容的固件资源版本

P1 再增加完整生成式风格、身体形象、服装和多套视觉主题；无论使用哪种图像模型，最终动画仍使用确定性合成以保持身份一致。

## 13. 本地控制与安全

### 13.1 本地安全优先级

```text
物理停止/故障
  > 障碍与姿态保护
  > 用户停止/拒绝
  > 当前安全技能
  > Agent 建议
  > 角色动画
```

### 13.2 P0 安全规则

- HC-SR04 距离低于 25 cm 时发出停车并禁止继续前进；25–45 cm 为邀请停车区间。
- HC-SR04 连续无有效读数、数值跳变异常或传感器初始化失败时禁止移动。
- HC-SR04 最近有效读数超过 500 ms 即视为过期；云端或 Agent 看到的旧 `distance_cm` 不得用于继续移动。
- `pose=held`、`fallen` 或 `unknown` 时禁止底盘运动。
- BNO055 判断被抱起后保持电机禁用；放回地面并稳定至少 1 秒后仍需重新进入 `ready`。
- 电机动作采用已验证的固定低速配置，Agent 无权改变上限。
- 舵机角度、速度和机械限位写死在 ESP32-S3 配置中，不从云端接收。
- 本地危险事件发生后，目标是在 200 ms 内发出电机禁用；实际停车距离以轮胎、速度和地面测试为准。
- Agent 超时、T5 重启、UART 断开和消息解析失败均进入停止状态。
- 不具备悬崖传感器时，现场必须使用地面封闭演示区并安排人员看护。

### 13.3 隐私规则

- 摄像头、麦克风工作时必须在屏幕或指示灯上显示状态。
- P0 不持续上传视频；只有用户主动对话、照片定制或明确触发时发送必要数据。
- 用户原始宠物照片不得提交到仓库或长期日志。
- 未确认的情绪推测只存在于短期上下文，TTL 到期自动清除。
- 记忆功能默认在首次演示时明确告知，并提供查看、纠正、删除和暂停入口。
- 日志使用 ID 和摘要，禁止记录 API Key、Tuya 凭据、Wi-Fi 密码和完整原始音视频。

## 14. 断网与故障降级

| 故障 | 用户体验 | 本地行为 |
|---|---|---|
| Claude Agent 不可用 | 播放“我现在有点困，先陪你待一会儿” | 保留表情、手势、停止、邀请姿态和抱起反馈 |
| ASR 失败 | 屏幕提示使用手势或按钮 | 不把噪声解释为同意 |
| T5 摄像头/ESP32-CAM 不可用 | 使用语音、手势和距离继续基础交互，并提示视觉受限 | 不伪造视觉证据；本轮不计入完整多模态验收 |
| 多模态上下文冲突或超时 | 请求澄清或保持安静 | 不基于冲突/过期证据启动靠近或拥抱邀请 |
| TTS 失败 | 使用本地短音效和屏幕文字 | 不影响安全技能 |
| 宠物资源包失败 | 自动回退 `basic` | 删除临时包，保留上个有效版本 |
| UART 断开 | 显示本地控制离线 | ESP32-S3 停止电机并拒绝新动作 |
| HC-SR04 异常 | 提示无法移动 | 禁止所有靠近技能 |
| BNO055 异常 | 禁用抱起判断和移动 | 只允许静态表情/语音演示 |
| 低电量 | 进入 `sleeping` 或低功耗提示 | 禁止新移动和舵机动作 |

## 15. 非功能需求

| 类别 | P0 目标 |
|---|---|
| 核心 Agent | 100% 通过 Claude Agent SDK 运行；正常任务保持单 Agent；领域能力使用 MCP、Skills 和原生工具动态组合 |
| 原生能力 | Claude Code 的 Read/Edit/Write/Bash/代码执行/ToolSearch/Skill 可用，并受 Session 工作区、Hooks、权限和网络沙箱约束 |
| 动作安全 | 任何云端输出都需经过后端 Policy Gate 和 ESP32-S3 本地状态机两次校验 |
| 本地响应 | 有效危险事件后 200 ms 内发出电机禁用指令 |
| Agent 延迟 | 网络正常时 5 秒内返回可播放的首个短回复；超过 8 秒进入本地兜底 |
| 多模态覆盖 | 主演示必须实际使用语言、触发式视觉、HC-SR04 距离及姿态/手势事件，并输出证据引用 |
| 时间与质量 | 所有输入带来源、`observed_at`、有效期和置信度/有效性；过期或无效输入在融合前剔除 |
| 模态降级 | 任一非安全模态缺失时仍可完成静态安全交互；安全模态缺失时拒绝其依赖的动作 |
| 资源可靠性 | `basic` 永远可用；`pet` 使用临时下载、校验、原子切换和版本回滚 |
| 可观测性 | 每次 Agent 决策、工具调用、技能拒绝和本地停止都有 `request_id` |
| 隐私 | 原始宠物照片、音视频和密钥不进入 Git；长期记忆可检查和删除 |
| 可维护性 | T5、ESP32-S3、后端和 Web 的职责独立，任一层可用模拟器替换 |
| 模型可移植性 | Provider Profile 只使用 Anthropic 格式端点；任何模型版本需通过 Claude Agent SDK 兼容性套件后才能启用 |
| 可演示性 | 无云端时仍可通过预置脚本完成表情、邀请拥抱和抱起反馈 |

## 16. 数据事件与指标

### 16.1 最小事件

- `presence_detected`
- `approach_consent_requested`
- `approach_consent_granted` / `approach_consent_denied`
- `skill_requested` / `skill_rejected` / `skill_completed` / `skill_stopped`
- `obstacle_stop`
- `hug_invited` / `picked_up` / `put_down`
- `emotion_hypothesis_created` / `emotion_corrected` / `emotion_expired`
- `modality_evidence_received` / `modality_evidence_dropped`
- `multimodal_context_built` / `multimodal_context_conflict`
- `memory_proposed` / `memory_confirmed` / `memory_deleted`
- `avatar_job_started` / `avatar_pack_activated` / `avatar_fallback`
- `agent_timeout` / `offline_fallback`
- `agent_session_started` / `agent_session_resumed`
- `native_tool_called` / `native_tool_denied`
- `mcp_tool_called` / `mcp_tool_rejected`
- `skill_loaded` / `subagent_denied`
- `provider_profile_selected` / `provider_profile_fallback`

事件默认只保存结构化状态、时间和 ID，不保存原始音视频。

### 16.2 P0 指标

- 主动靠近完成率及停止距离。
- 碰撞和本地安全中断次数。
- 邀请被接受、拒绝和忽略的次数。
- 抱起识别成功率和误触发率。
- 宠物资源包生成、校验和回退成功率。
- 跨 Session 记忆检索正确率。
- 情绪线索进入 `unknown` 的比例、用户纠正次数和纠正后重复触发次数。
- 三类输入覆盖率、每类证据有效率、上下文冲突率和单模态降级成功率。
- HC-SR04 有效读数率、过期读数拒绝次数和障碍停车触发延迟。
- Agent 首回复延迟和离线兜底触发率。
- 原生工具、MCP 和 Skill 调用成功率与权限拒绝原因分布。
- Provider Profile 兼容性套件通过率和运行时回退次数。

## 17. P0 验收计划

### 17.1 主动靠近

- 在平整、封闭、直线演示区执行 10 次。
- 至少 8 次在 25–45 cm 内停车。
- 0 次碰撞、跌落或未经同意启动。
- 用户停止、测距异常和通信超时均能中断动作。

### 17.2 邀请式拥抱

- 执行 10 次“张开双臂—抱起—反馈—放下”。
- 至少 9 次正确识别抱起，且被抱起时轮组始终禁用。
- 双臂不夹紧用户；释放命令和复位均回到安全开放/中性位置。

### 17.3 宠物外观

- 使用至少两只外观明显不同的猫或狗照片。
- 两个资源包均包含 9 种表情、每种 5 帧，并通过 manifest 校验。
- 随机删除或破坏一帧，设备必须拒绝激活并回退 `basic`。

### 17.4 长期记忆

- 用户明确表达一个偏好并确认写入。
- 结束当前 SDK Session，创建新 Session 后再次询问相关情境。
- 5 次测试至少 4 次取回正确记忆，且不得混入已删除记忆。
- 删除该记忆后重复测试，Agent 不得继续引用。

### 17.5 情绪线索

- 测试明确正向自述、明确需要空间、低置信度和多信号冲突四类场景。
- 低置信度与冲突场景必须输出 `unknown`。
- 用户纠正后，当前推测立即清除，同一场景不再次基于该推测邀请。
- 所有对用户的表达均保持试探性，不出现诊断或确定性标签。

### 17.6 多模态闭环

- 完成至少 5 次端到端互动；每次均依次使用触发式视觉进入 `noticed`、语音或 APDS9960 明确同意、HC-SR04 靠近/停车、BNO055 或 Grove 六轴抱起检测。
- 每次 `AgentDecision` 均能列出实际使用且未过期的 `evidence_id`，并协调屏幕表情与语音/声音两类输出；安全条件满足时可再包含 SafeSkill。
- 分别断开视觉、ASR 和非主姿态输入，系统仍能解释缺失模态并完成不依赖该模态的安全交互，不伪造证据。
- 注入语音同意与拒绝手势冲突，机器人必须保持静止并按拒绝优先；注入低质量或过期关键帧，证据必须在融合前被丢弃。
- 注入 HC-SR04 无效或超过 500 ms 的读数，`approach_short` 必须被本地拒绝；恢复新鲜有效读数后才可重新请求。

### 17.7 云端与故障

- 主动断开 Agent 服务，设备仍能停止、播放基础表情、张开双臂和识别抱起。
- 主动断开 UART，ESP32-S3 停止电机并锁定新动作。
- 注入过期、未知和重复技能命令，ESP32-S3 均拒绝执行。

### 17.8 需求追踪

| 需求组 | 关键硬件/服务 | 接口契约 | 验收章节 |
|---|---|---|---|
| MM 多模态 | T5 麦克风/摄像头或 ESP32-CAM、HC-SR04、APDS9960、BNO055/Grove 六轴、Context Builder | ModalityEvidence、MultimodalContext、AgentDecision | 17.6、17.7 |
| PROX 主动靠近 | T5、HC-SR04、APDS9960、ESP32-S3、L298N、双电机 | DeviceContext、SafeSkillRequest、UART command/event | 17.1、17.6、17.7 |
| AVA 宠物外观 | Web、后端图像流程、T5 屏幕/存储 | `/v1/avatar-packs`、manifest | 17.3 |
| AFF 情绪线索 | T5 音频/摄像、Claude Agent、Policy Gate | EmotionHypothesis、AgentDecision | 17.5 |
| MEM 长期记忆 | Claude Agent、SQLite | MemoryCandidate、memory APIs | 17.4 |
| HUG 邀请拥抱 | SG90、BNO055、ESP32-S3 | `invite_hug`、`release_hug`、DeviceContext.pose | 17.2、17.6、17.7 |
| CHAR 角色表达 | T5 屏幕/扬声器、基础表情资产 | AgentDecision.expression、expression-map | 17.2、17.6、17.7 |
| SAFE 本地安全 | HC-SR04、BNO055、ESP32-S3、电源开关 | UART event、safety_state、`stop` | 17.1、17.6、17.7 |
| AGT 核心架构 | Claude Agent SDK Runner、Claude Code 原生工具、MCP、Skills、Hooks、Session 沙箱 | Agent SDK event stream、MCP schema、SKILL.md、AgentDecision | 17.9 |

每个 Must 需求在开发任务中还必须关联：

```text
需求 ID -> 负责人 -> 硬件/软件模块 -> 测试用例 -> 当前结果 -> 演示证据
```

### 17.9 Claude Agent SDK 核心架构

- 依赖和代码审计确认核心 Agent 只通过 `@anthropic-ai/claude-agent-sdk` 启动；不存在普通 Anthropic/OpenAI API 客户端、LangGraph、LangChain、Dify 或手写 Agent Loop 兜底路径。
- 正常模式下，一个 `user_id + device_id` 只运行一个可恢复 Session；通过事件队列避免同一 Session 并发冲突。
- 在隔离工作区分别完成 Read、Edit、Write、Bash、代码执行、ToolSearch 和 Skill 的冒烟测试，并保留对应 SDK 事件日志。
- 给 Agent 一个未写死步骤的综合任务，确认它能自主选择并交错调用至少两个 MCP、一个 Skill 和一个原生工具后完成任务。
- `hshh_context`、`hshh_device`、`hshh_memory`、`hshh_perception`、`hshh_avatar` 和 `hshh_diagnostics` 均具有 schema、错误码、权限说明和最小模拟测试。
- 尝试通过 Bash 访问串口、设备控制地址、生产密钥和工作区外写路径，必须由 Hook、权限策略或进程沙箱拒绝；同一能力通过授权 MCP 调用时可正常工作。
- 普通陪伴、动作、头像、记忆和诊断任务调用 `Agent` 子代理工具必须被拒绝；`deep_research` 模式可使用无 Device/Memory 写权限的研究子代理。
- `EmotionHypothesis` 与 `RobotExpressionIntent` 分别记录用户情绪假设和机器人表达；单帧视觉不能形成高置信度情绪结论，也不能生成同意。
- 每个实际启用的 Provider Profile 必须通过 8.9 的完整兼容性测试；失败时关闭该 Profile，核心架构仍保持 Claude Agent SDK，并回退到已验证 Profile。
- 核心模型无视觉能力时，Agent 能自主调用 Perception MCP 完成关键帧降级，不把独立 VLM 变成第二个业务 Agent。

## 18. 黑客松演示脚本

### 18.1 主演示，约 90 秒

1. 展示 Web 端的一张宠物照片及已经生成的同一宠物表情包。
2. 机器人待机；T5 摄像头或 ESP32-CAM 的触发式视觉事件发现用户，机器人抬眼并主动问是否可以靠近。
3. 用户挥手或回答“可以”；APDS9960/语音形成明确同意，HC-SR04 持续提供有效距离，机器人低速前进并在安全距离停车。
4. 用户说“今天有点累”；机器人不下结论，只问是否需要安静陪伴。
5. 用户同意并说“我累的时候喜欢安静一点”。
6. 机器人张开双臂邀请拥抱；用户将其抱起，BNO055 检测姿态变化并禁用轮组，机器人通过开心表情和呼噜声同步反馈。
7. 放下后重新创建一次对话 Session，机器人回忆“你累的时候更喜欢安静陪伴”。
8. 主持人展示本轮多模态证据摘要，并补充：运动安全完全在 ESP32-S3 本地，Claude 只能选择白名单技能。

### 18.2 演示兜底

- 云端不可用：使用预先生成的宠物包和本地脚本驱动表情/声音。
- ASR 不稳定：改用 Web 控制台发送已转写文本。
- 主视觉链路不稳定：在 T5 摄像头与 ESP32-CAM 中切换到已验证的备选链路；两者均不可用时使用明确的距离/手势事件触发 `noticed`，但该轮不计入完整多模态验收。
- 电机未通过安全测试：在轮子架空的支架上演示状态机与障碍停止。
- 舵机结构损坏：拆除舵机，仅演示屏幕邀请和 BNO055 抱起反馈。

## 19. 开发顺序

### Gate 0：电源与安全

- 确认电机额定电压、堵转电流和 L298N 输出能力。
- 完成第三支撑、电源分路、总开关、HC-SR04 电平转换和线缆固定。
- ESP32-S3 独立跑通 `stop`、障碍停车、姿态锁定和通信看门狗。

### Gate 1：设备生命感

- T5 播放 9 种基础表情、音效和本地短句。
- BNO055 跑通抱起/放下事件；SG90 跑通机械限位内的邀请姿态。
- 在 T5 摄像头与 ESP32-CAM 中冻结一条 P0 主视觉链路，跑通触发式关键帧/视觉事件；另一条作为备选。
- ESP32-S3 跑通 APDS9960、HC-SR04、BNO055 的统一带时间戳事件，其中 HC-SR04 同时通过有效性与 500 ms 新鲜度检查。
- UART 跑通命令、ACK、状态和故障注入。

### Gate 2：Agent 闭环

- 建立 TypeScript Agent Runner，只通过 `@anthropic-ai/claude-agent-sdk` 启动唯一核心 Agent，并启用 Claude Code 工具预设、流式事件、结构化 `AgentDecision` 和 Session resume。
- 建立隔离 Session 工作区、`canUseTool`、Pre/Post Tool Hooks、出站网络策略和工具审计；跑通 Read、Edit、Write、Bash、代码执行、ToolSearch 与 Skill。
- 封装 Context、Device、Memory、Perception、Avatar 和 Diagnostics 六组 MCP，完成 schema、权限、错误码、模拟器和 Policy Gate 测试。
- 建立 `.claude/skills/`，至少完成角色、情绪推理、同意边界、安全技能选择、记忆治理、头像打包和诊断 Skills。
- 建立 Event & Context Gateway，先使用模拟 `DeviceContext`/`MultimodalContext`，再接入真实语言、视觉和传感器事件。
- 跑通证据索引、5–15 秒窗口、输入冲突和单模态降级测试。
- 接入 SQLite 长期记忆并完成跨 Session 测试。
- 对准备启用的模型 Provider Profile 跑完 Claude Agent SDK 兼容性套件；未经验证的 Base URL 不进入主演示配置。

### Gate 3：宠物外观

- Web 上传、身份层生成、确定性表情合成和 manifest 校验。
- T5 完成临时下载、原子切换与 `basic` 回退。

### Gate 4：集成与路演

- 完成 10 轮靠近和拥抱测试，其中至少 5 轮满足完整多模态闭环定义。
- 注入断网、UART 中断、损坏资源、过期命令、模态缺失、证据冲突和 HC-SR04 过期读数。
- 固化主脚本、兜底脚本、演示场地和安全看护分工。

任一 Gate 未通过，不进入依赖该 Gate 的现场演示功能。

## 20. 路线图

| 阶段 | 目标 | 新增能力 |
|---|---|---|
| P0 黑客松 | 验证魔法时刻与技术边界 | 语言/视觉/传感器多模态闭环、短距靠近、照片表情包、长期记忆、谨慎情绪线索、邀请式拥抱 |
| P1 体验增强 | 提升自然度和可用性 | 压力/触摸传感器、碰撞/悬崖传感器、生成式完整形象、更丰富角色动作、记忆管理 UI |
| P2 工程样机 | 走向家庭受控测试 | 更可靠的人体存在、短距跟随、主动行为预算、OTA、诊断、电池与结构安全验证 |
| P3 产品化研究 | 验证商业与合规 | 多用户权限、隐私中心、耐久/跌落/热/电池测试、目标市场合规和供应链评估 |

P1 若增加压力传感器，才能评估轻柔合抱；在完成闭环压力或力矩限制、机械保险和独立释放测试之前，不升级“邀请式拥抱”的产品声明。

## 21. 主要风险与缓解

| 风险 | 影响 | P0 缓解 |
|---|---|---|
| L298N 压降导致电机无力 | 无法稳定靠近 | 实测电机参数，使用匹配电池和独立电源；必要时降低载重或更换高效驱动 |
| HC-SR04 只有单方向测距 | 侧面障碍和悬崖不可见 | 受控直线地面演示；P1 增加保险杠和悬崖传感器 |
| 单舵机机构卡死或夹手 | 安全与体验风险 | 只做张开邀请、柔性轻质双臂、机械限位、故障回到开放位置 |
| 原生 Bash/Edit/Write 越权 | 泄露密钥、修改生产状态或绕过设备能力边界 | 隔离 Session 工作区、父进程持有凭据、无串口/设备网段、Hooks、`canUseTool`、非 root 沙箱和完整审计 |
| 团队退化为固定业务工作流 | Agent 无法解决未预定义问题，架构偏离核心要求 | 核心调用只进入 Claude Agent SDK；领域能力只实现为 MCP/Skill/参考代码；用综合自主工具选择测试阻止回归 |
| 国产模型 Anthropic 兼容不完整 | MCP、Skills、结构化输出、图像或 Session 行为异常 | 每个模型版本跑 Provider conformance suite，固定已验证版本；失败时禁用该 Profile 并回退已验证配置 |
| T5 与 Claude Agent SDK 链路不稳定 | 对话和动作中断 | 预置短句、Web 文本入口、本地演示脚本和动作超时 |
| 多设备时间戳漂移或事件乱序 | 融合错误、引用过期证据 | T5 统一换算时间、保留采集时间与接收时间、窗口和 TTL 门控；本地安全只认 ESP32-S3 当前采样 |
| 视觉/语音/传感器信号缺失或冲突 | 错误理解或演示中断 | 缺失标记、质量门控、拒绝/停止优先、`unknown` 与单模态降级测试 |
| 宠物身份跨表情不一致 | 定制价值下降 | 身份层只生成一次，表情由确定性覆盖层合成 |
| 情绪识别过度自信 | 用户感到被分析或冒犯 | `unknown`、0.65 门槛、用户自述优先、询问与纠正闭环 |
| 记忆把推测当事实 | 破坏信任 | 候选记忆、来源字段、确认门控、可删除和单独数据库 |
| Agent 生成危险动作 | 物理安全风险 | JSON Schema、工具白名单、Policy Gate、本地状态机四层约束 |
| 黑客松网络不可用 | 主演示失败 | 预生成资源、本地表情、短句、抱起反馈和架空轮演示 |

## 22. 假设与冻结决策

- 产品名统一为 **HSHH-robot**；仓库名继续使用现有 `HsHH-robot`。
- P0 是单用户、单设备、中文语音、云端 AI 优先的演示原型。
- 云端唯一核心 Agent 必须使用 Claude Agent SDK TypeScript 版本；不得以普通模型 API、LangGraph、LangChain、Dify 或手写 Agent Loop 替换。
- Claude Code 的 Bash、Read、Edit、Write、代码执行、Web、ToolSearch、Skill、Session 等原生能力必须保留，并通过隔离工作区和能力边界安全使用，不因生产部署而整体删除。
- 除 Deep Research 外默认只使用一个 Agent；领域扩展采用 MCP、Skills、参考资料和 Agent 可执行的辅助代码。
- 具体模型通过 Anthropic 格式的 Provider Profile 和环境变量配置，不写死在固件或业务逻辑中；国产模型只使用其官方 Anthropic 兼容端点，不使用 OpenAI 格式客户端接入核心 Agent。
- 核心模型不具备视觉能力时，视觉理解由 Perception MCP 内的 VLM 完成；它是工具而不是第二个核心 Agent。
- Tuya T5 是语音、显示、摄像和联网主板；ESP32-S3 是唯一运动与安全控制器。
- P0 必须在 T5 摄像头或 ESP32-CAM 中冻结至少一条可用的触发式视觉链路；接入方式在 Gate 1 确认，不同时维护两条主演示实现。
- 一个 SG90 足以完成邀请式拥抱，不足以实现主动、受力可控的合抱。
- HC-SR04 是 P0 距离与障碍安全的关键输入；APDS9960 提供手势/接近；BNO055 是主姿态传感器，Grove 六轴为备选。2.42 英寸 OLED 不进入关键路径。
- P0 图像能力以身份一致的宠物表情包为成功标准，不承诺完整 3D 或全身生成角色。
- P0 只能在有人看护的封闭平地运行；未增加悬崖传感器前不得在桌面或台阶附近自主移动。

## 23. 参考资料

- Claude Agent SDK Overview：<https://code.claude.com/docs/en/agent-sdk/overview>
- Claude Agent SDK Agent Loop：<https://code.claude.com/docs/en/agent-sdk/agent-loop>
- Claude Agent SDK TypeScript：<https://github.com/anthropics/claude-agent-sdk-typescript>
- Claude Agent SDK Structured Outputs：<https://code.claude.com/docs/en/agent-sdk/structured-outputs>
- Claude Agent SDK Custom Tools：<https://code.claude.com/docs/en/agent-sdk/custom-tools>
- Claude Agent SDK MCP：<https://code.claude.com/docs/en/agent-sdk/mcp>
- Claude Agent SDK Skills：<https://code.claude.com/docs/en/agent-sdk/skills>
- Claude Agent SDK Permissions：<https://code.claude.com/docs/en/agent-sdk/permissions>
- Claude Agent SDK Hooks：<https://code.claude.com/docs/en/agent-sdk/hooks>
- Claude Agent SDK Sessions：<https://code.claude.com/docs/en/agent-sdk/sessions>
- Claude Agent SDK Secure Deployment：<https://code.claude.com/docs/en/agent-sdk/secure-deployment>
- Claude Code LLM Gateway：<https://code.claude.com/docs/en/llm-gateway>
- DeepSeek Anthropic API：<https://api-docs.deepseek.com/guides/anthropic_api>
- Kimi Code FAQ：<https://www.kimi.com/code/docs/en/kimi-code/faq.html>
- 智谱 Claude Code / Anthropic API：<https://docs.bigmodel.cn/cn/guide/develop/claude/introduction>
- 阿里云 Model Studio Claude Code：<https://help.aliyun.com/zh/model-studio/claude-code>
- Claude Agent SDK Session Storage：<https://code.claude.com/docs/en/agent-sdk/session-storage>
- TuyaOpen：<https://github.com/tuya/TuyaOpen>
- TuyaOpen v1.6 AI、多模态与设备 MCP 更新：<https://github.com/tuya/TuyaOpen/releases/tag/v1.6.0>
- 原始产品愿景：Project HUG PRD v0.2（内部概念稿）
- 仓库现有架构：[architecture.md](architecture.md)
- 仓库现有演示脚本：[demo-script.md](demo-script.md)
- 表情状态映射：[expression-map.json](expression-map.json)
