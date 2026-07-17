---
name: data-analysis-pipeline
description: 完整的数据分析业务闭环：从 Excel/CSV 读取 → 数据清洗 → 分析洞察 → 生成报告 → 导出结果。当用户提到数据分析、表格分析、数据报告、Excel 分析时触发。
version: 1.0.0
metadata:
  tags:
    - data-analysis
    - excel
    - report
    - automation
  category: productivity
security:
  requireApproval:
    - 覆盖已有文件
---

# 数据分析业务闭环

## 目标
实现"一句话完成数据分析"：用户给出数据文件，Agent 自动完成完整分析流程。

## 闭环流程

```
用户上传数据文件
    ↓
[1/5] 数据读取 → xlsx_read / csv_parse 解析数据
    ↓
[2/5] 数据清洗 → 自动检测空值/异常值/类型混合
    ↓
[3/5] 数据洞察 → data_insight 生成统计报告
    ↓
[4/5] 可视化建议 → 根据数据类型推荐图表
    ↓
[5/5] 导出报告 → xlsx_write 生成分析结果 Excel + Markdown 报告
    ↓
交付：分析结果文件 + 关键发现摘要
```

## 使用方式

### 方式一：一句话指令
```
"帮我分析这个 Excel 文件，生成数据报告"
```

### 方式二：分步指令
```
"读取 data.xlsx，先做数据清洗，然后生成分析报告"
```

## 自动检测场景

| 场景 | 自动动作 |
|------|----------|
| 数值列过多 | 推荐趋势分析 + 统计摘要 |
| 文本列过多 | 推荐词频分析 + 分类统计 |
| 时间列存在 | 推荐时间序列分析 |
| 缺失值 >30% | 警告并建议处理方案 |
| 类型混合列 | 自动拆分或标记 |

## 输出交付物

1. **分析结果 Excel**（`analysis_result.xlsx`）
   - Sheet1: 清洗后数据
   - Sheet2: 统计摘要
   - Sheet3: 洞察发现

2. **Markdown 报告**（`analysis_report.md`）
   - 数据概览
   - 关键发现
   - 建议行动

3. **对话摘要**（直接回复）
   - 3-5 条核心发现
   - 1 个建议行动

## 示例对话

**用户**: "分析这个销售数据文件"

**Agent 执行**:
1. `xlsx_read` 读取 sales_data.xlsx
2. `data_insight` 生成洞察报告
3. `xlsx_write` 导出分析结果
4. 回复: "分析完成！发现：1) Q4 销售额环比增长 23% 2) 产品 A 占比 45% 3) 华东区贡献最大。详细报告已保存到 analysis_result.xlsx"

## 依赖工具

| 工具 | 用途 |
|------|------|
| `xlsx_read` | 读取 Excel 文件 |
| `csv_parse` | 解析 CSV 文件 |
| `data_insight` | 生成数据洞察 |
| `xlsx_write` | 导出分析结果 |
| `xlsx_append` | 追加分析数据 |

## 注意事项

- 大文件（>10MB）建议先采样分析
- 敏感数据注意脱敏
- 分析结果需人工确认关键发现
