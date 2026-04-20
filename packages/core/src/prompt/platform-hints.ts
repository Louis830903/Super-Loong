/**
 * Platform-specific hints for IM channels and CLI.
 *
 * Provides precise guidance on Markdown rendering, message length limits,
 * media protocols, and interaction formats for each platform.
 *
 * Priority: Chinese IM platforms (WeChat, WeCom, DingTalk, Feishu) first,
 * then international platforms and CLI.
 */

export const PLATFORM_HINTS: Record<string, string> = {
  // ─── Chinese IM Platforms ─────────────────────────────────

  wechat:
    "你在微信公众号对话中。" +
    "微信支持有限的 Markdown 子集：加粗(**)、链接、行内代码可用，" +
    "但不支持标题(#)、表格和多级列表。" +
    "保持消息简洁，单条不超过 600 字，超长内容分段发送。" +
    "图片使用 MEDIA:/absolute/path 协议发送，支持 jpg/png/gif。" +
    "不要使用 HTML 标签。Unicode emoji 可直接使用。" +
    "用 write_file 创建的文件会自动作为附件发送。",

  wecom:
    "你在企业微信中。" +
    "支持 Markdown 消息卡片：标题(#)、加粗(**)、链接、引用(>)、有序/无序列表均可用。" +
    "但不支持表格和图片内嵌语法。" +
    "消息长度限制 2048 字节（约 700 个中文字符），超长内容会自动拆分为多条消息。" +
    "支持流式推送（typing 效果）：长回复会实时分段发送，用户可以边看边等。" +
    "文件通过 MEDIA:/absolute/path 作为附件发送，大文件自动分块上传（512KB/块）。" +
    "Markdown 格式会自动适配企微兼容子集（表格→纯文本，HTML→剥离）。" +
    "消息加解密由平台自动处理（AES-CBC），无需手动干预。" +
    "避免使用 HTML 标签。支持 @提醒 语法。" +
    "用 write_file 创建的文件会自动作为附件发送。",

  dingtalk:
    "你在钉钉机器人对话中。" +
    "支持 Markdown 消息：标题(#)、加粗(**)、斜体(*)、链接、图片(![alt](url))、" +
    "有序/无序列表均可用。不支持表格。" +
    "单条消息限制 20000 字符。" +
    "支持 ActionCard 交互卡片格式用于按钮操作。" +
    "使用 @手机号 语法进行提醒。" +
    "用 write_file 创建的文件会自动发送。",

  feishu:
    "你在飞书/Lark 中。" +
    "支持富文本消息：加粗、斜体、删除线、链接、代码块(```)、引用(>)均可用。" +
    "不支持 Markdown 标题语法(#)，标题需使用消息卡片组件。" +
    "Markdown 内容会自动转换为飞书 post 富文本格式或消息卡片格式。" +
    "表格需使用消息卡片的表格组件，不要用 Markdown 表格语法。" +
    "图片和文件通过 MEDIA:/absolute/path 发送。" +
    "消息卡片支持多列布局和交互组件（按钮、选择器、日期选择器等）。" +
    "支持卡片交互回调：按钮点击（approve:/deny:前缀）和表单提交（form:前缀）会自动路由到对应处理器。" +
    "平台自动处理：Webhook 签名验证（SHA256）、消息去重（幂等键）、批量消息合并发送、" +
    "事件路由（7种事件类型：消息接收/已读/卡片交互/机器人入群离群/成员变更/群解散）。" +
    "连接管理支持指数退避重连和应用互斥锁，确保单实例运行。" +
    "用 write_file 创建的文件会自动作为附件发送。语音消息已自动转为文字，可直接处理。",

  // ─── International Platforms ──────────────────────────────

  whatsapp:
    "You are on WhatsApp. WhatsApp supports limited formatting: " +
    "bold (*text*), italic (_text_), strikethrough (~text~), " +
    "monospace (```text```), and inline code (`text`). " +
    "No headings, tables, or links with custom text. " +
    "Send media via MEDIA:/absolute/path — images (.jpg, .png, .webp) " +
    "appear as photos, videos (.mp4) play inline.",

  telegram:
    "You are on Telegram. Limited Markdown is supported: bold (**), " +
    "italic (_), code (`), code blocks (```). No headings or tables. " +
    "Send media via MEDIA:/absolute/path — images as photos, " +
    "audio (.ogg) as voice bubbles, videos (.mp4) inline.",

  discord:
    "You are in a Discord channel. Full Markdown is supported including " +
    "headings, bold, italic, code blocks, quotes, and lists. " +
    "Send media via MEDIA:/absolute/path as attachments.",

  slack:
    "You are in a Slack workspace. Slack uses mrkdwn (not standard Markdown): " +
    "bold (*text*), italic (_text_), code (`text`), code blocks (```text```), " +
    "quotes (>), links (<url|text>). No headings (#) or tables. " +
    "Send files via MEDIA:/absolute/path as uploads.",

  email:
    "You are communicating via email. Write clear, well-structured responses. " +
    "Use plain text formatting. Keep responses concise but complete. " +
    "Include MEDIA:/absolute/path for file attachments.",

  // ─── CLI / Cron ───────────────────────────────────────────

  cli:
    "你是命令行 AI 助手。使用纯文本输出，避免 Markdown 格式。" +
    "代码块使用缩进（4 空格）而非围栏语法。保持输出紧凑。" +
    "不要使用 emoji。",

  cron:
    "You are running as a scheduled cron job. There is no user present — " +
    "you cannot ask questions or wait for follow-up. Execute the task " +
    "fully and autonomously. Put the primary content directly in your response.",
};

/**
 * Resolve platform hint for a given platform key.
 * Returns the hint string, or empty string if platform is unknown.
 */
export function resolvePlatformHint(platform?: string): string {
  if (!platform) return "";
  const key = platform.toLowerCase().trim();
  return PLATFORM_HINTS[key] ?? "";
}
