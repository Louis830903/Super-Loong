---
name: project-management
description: 项目管理业务闭环：项目创建 → 任务分解 → Agent 分配 → 进度跟踪 → 成果交付。当用户提到项目管理、任务分配、团队协作、进度跟踪时触发。
version: 1.0.0
metadata:
  tags:
    - project-management
    - team
    - collaboration
    - tracking
  category: business
security:
  requireApproval:
    - 分配关键任务
    - 修改项目里程碑
---

# 项目管理业务闭环

## 目标
实现"一句话管理项目"：用户描述项目需求，Agent 自动完成项目拆解、任务分配、进度跟踪。

## 闭环流程

```
用户描述项目需求
    ↓
[1/7] 项目创建 → 明确目标、范围、时间、资源
    ↓
[2/7] 任务分解 → WBS 工作分解结构
    ↓
[3/7] Agent 匹配 → 根据任务类型分配最合适专家
    ↓
[4/7] 任务分配 → 明确责任人、截止时间、交付物
    ↓
[5/7] 进度跟踪 → 定期检查任务状态
    ↓
[6/7] 风险管理 → 识别风险，制定应对
    ↓
[7/7] 成果交付 → 汇总成果，质量检查
    ↓
交付：项目计划 + 任务清单 + 进度报告
```

## 使用方式

### 方式一：一句话指令
```
"帮我管理新产品上线项目，需要协调设计、开发、运营"
```

### 方式二：分步指令
```
"创建一个电商运营优化项目，分解任务并分配给合适的 Agent"
```

## 项目分解模板

### 阶段一：启动（5%）
- 项目章程
- 干系人识别
- 初步范围定义

### 阶段二：规划（20%）
- 详细 WBS
- 资源计划
- 风险登记册
- 沟通计划

### 阶段三：执行（50%）
- 任务分配
- 团队协作
- 进度跟踪
- 质量保证

### 阶段四：监控（15%）
- 绩效测量
- 变更控制
- 风险应对
- 干系人沟通

### 阶段五：收尾（10%）
- 成果验收
- 经验总结
- 文档归档
- 团队释放

## Agent 分配策略

| 任务类型 | 推荐 Agent | 备选 |
|----------|-----------|------|
| 需求分析 | product-manager | business-analyst |
| UI/UX 设计 | design-ui-designer | ux-architect |
| 前端开发 | engineering-frontend-developer | senior-developer |
| 后端开发 | engineering-backend-architect | ai-engineer |
| 数据分析 | data-consolidation-agent | data-engineer |
| 测试 | testing-api-tester | quality-assurance |
| 文档 | engineering-technical-writer | content-creator |
| 营销 | marketing-growth-hacker | social-media-strategist |

## 输出交付物

1. **项目计划书**（`project_plan.md`）
   - 项目概述
   - 目标与范围
   - 里程碑计划
   - 资源分配
   - 风险管理

2. **任务清单**（`task_list.xlsx`）
   - 任务 ID
   - 任务名称
   - 负责人
   - 开始/截止时间
   - 状态
   - 依赖关系

3. **进度报告**（`progress_report.md`）
   - 完成百分比
   - 关键路径
   - 风险预警
   - 下一步计划

4. **对话摘要**（直接回复）
   - 项目状态（1 句话）
   - 关键风险（2 个）
   - 需要决策（1 个）

## 示例对话

**用户**: "管理我们的电商大促项目，需要协调运营、设计、技术"

**Agent 执行**:
1. 创建项目：电商大促项目，目标 GMV 100 万
2. 分解任务：活动策划、页面设计、技术准备、推广执行、数据分析
3. 分配 Agent：
   - 活动策划 → marketing-ecommerce-operator
   - 页面设计 → design-ui-designer
   - 技术准备 → engineering-backend-architect
   - 推广执行 → marketing-growth-hacker
   - 数据分析 → data-consolidation-agent
4. 生成任务清单和里程碑
5. 回复: "项目已创建！5 个核心任务已分配给 5 位专家。关键路径：技术准备 → 页面设计 → 推广执行。建议每日站会同步进度。"

## 依赖工具

| 工具 | 用途 |
|------|------|
| `todo_manage` | 任务创建和跟踪 |
| `xlsx_write` | 导出任务清单 |
| `data_insight` | 进度数据分析 |
| `agent-matcher` | 智能分配 Agent |
| `subagent-spawn` | 创建子代理执行任务 |

## 注意事项

- 关键任务需人工确认分配
- 定期检查进度，及时调整
- 风险早发现、早应对
- 保持沟通透明
