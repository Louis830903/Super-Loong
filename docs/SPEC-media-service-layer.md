# Super Agent 媒体服务层改造 — 技术规格与开发计划

> **基于 OpenClaw 附件处理最佳实践的深度调研成果**
>
> 版本: v1.0 | 日期: 2026-04-16 | 状态: 待评审

---

## 一、背景与目标

### 1.1 当前痛点

| 维度 | 现状 | 问题 |
|------|------|------|
| 架构 | 前端 `page.tsx` 直接 `readFileAsText/readFileAsBase64` 读取文件内容 | 无独立媒体服务层，前后端耦合严重 |
| 类型定义 | `Attachment { path, mimeType?, caption? }` 仅 3 字段 | 不支持 URL 引用、Base64 内联、Buffer 传输 |
| IM 桥接 | `bridge.py` 仅文本拼接 `MEDIA:path` 标记 | 无结构化附件处理、无 MIME 检测、无文件校验 |
| 安全 | 无路径校验、无 SSRF 防护、无大小限制 | 任意路径可被读取，存在路径遍历风险 |
| 渠道适配 | 无渠道适配器抽象 | 微信/飞书/钉钉各有不同媒体 API，但没有统一适配层 |
| 存储管理 | 无临时文件生命周期管理 | 附件文件无 TTL 清理，可能导致磁盘泄漏 |
| 错误处理 | `bridge.py` 仅 `os.path.isfile` 检查 | 无重试机制、无降级策略、无详细错误分类 |

### 1.2 改造目标

参考 OpenClaw 5 层分层架构（工具 Schema → Action Runner → Media Service → 渠道适配器 → 安全守卫），为 Super Agent 建立：

1. **独立媒体服务层** (`packages/core/src/media/`) — P0
2. **增强的 Attachment 类型系统** — P0
3. **结构化 IM 桥接附件处理** — P1
4. **渠道媒体适配器** (微信/飞书/钉钉) — P1
5. **安全防护层** — P1
6. **Runtime 自动媒体处理管道** — P2

---

## 二、参考架构对比

### OpenClaw 5 层架构

```
Agent Tool Schema (message-tool.ts)
    ↓ media/buffer/filename/contentType 参数
Action Runner (message-action-runner.ts)
    ↓ collectActionMediaSourceHints → normalizeSandboxMediaParams
Media Service Layer (media/)
    ├── parse.ts          → MEDIA: 标记解析 (MEDIA_TOKEN_RE)
    ├── web-media.ts      → 统一加载器 (URL/本地/Base64)
    ├── store.ts          → Claim-Check 存储 (UUID/TTL/并发安全)
    ├── local-media-access.ts → 白名单路径验证
    └── outbound-attachment.ts → 出站附件解析
    ↓
Channel Extensions (extensions/slack|signal|telegram|...)
    ↓ 各渠道独立 sendMedia 实现
Security Guards
    ├── SSRF 防护 (内网 IP 拒绝)
    ├── Symlink 拒绝 (realpath 校验)
    ├── MIME 双重验证 (扩展名 + Magic Bytes)
    └── 大小限制 (MEDIA_MAX_BYTES = 5MB)
```

### Super Agent 目标架构

```
前端 page.tsx (仅负责 UI 展示，不再读取文件内容)
    ↓ FormData / multipart upload
API Layer (packages/api)
    ↓ /api/media/upload → 返回 mediaId
Core Media Service (packages/core/src/media/)  ← 新建
    ├── types.ts          → MediaDescriptor / MediaKind / 增强 Attachment
    ├── parse.ts          → MEDIA: 标记解析
    ├── loader.ts         → 统一媒体加载器 (URL/本地路径/Base64)
    ├── store.ts          → 本地临时存储 (UUID命名/TTL自动清理)
    ├── mime.ts           → MIME 检测与验证
    ├── security.ts       → 路径白名单/大小限制/SSRF 防护
    ├── constants.ts      → 常量定义
    └── index.ts          → 统一导出
    ↓
IM Gateway (services/im-gateway/)
    ├── bridge.py         → 增强: 结构化附件处理 + 媒体分类
    └── adapters/         → 新建: 渠道媒体适配器
        ├── base.py       → 抽象基类 ChannelMediaAdapter
        ├── wecom.py      → 企业微信适配器
        ├── feishu.py     → 飞书适配器
        └── dingtalk.py   → 钉钉适配器
    ↓
Runtime (packages/core/src/agent/runtime.ts)
    └── 增强: 自动 MEDIA: 标记解析管道
```

---

## 三、详细技术规格

### Task 1: 核心类型系统增强 (P0)

**目标文件**: `packages/core/src/types/index.ts`

**修改内容**: 增强 `Attachment` 接口，新增 `MediaKind` 和 `MediaDescriptor` 类型

```typescript
// ─── Media Types ─────────────────────────────────────────────

/** 媒体分类，用于渠道适配器选择发送方法 */
export type MediaKind = "image" | "video" | "audio" | "document" | "file";

/** 增强的附件接口 — 对标 OpenClaw 多源支持 */
export interface Attachment {
  /** 本地文件绝对路径 */
  path?: string;
  /** 远程 URL (HTTP/HTTPS) */
  url?: string;
  /** Base64 编码的文件内容 (不含 data: 前缀) */
  base64?: string;
  /** MIME 类型 (自动检测或显式指定) */
  mimeType?: string;
  /** 原始文件名 */
  filename?: string;
  /** 附件说明/标题 */
  caption?: string;
  /** 媒体分类 (自动推断或显式指定) */
  kind?: MediaKind;
  /** 文件大小 (字节) */
  size?: number;
}

/** 媒体服务内部描述符 — 加载完成后的标准化结构 */
export interface MediaDescriptor {
  /** 本地临时文件路径 */
  localPath: string;
  /** Buffer 数据 */
  buffer: Buffer;
  /** 确定的 MIME 类型 */
  contentType: string;
  /** 媒体分类 */
  kind: MediaKind;
  /** 原始/推断的文件名 */
  filename: string;
  /** 文件大小 (字节) */
  size: number;
}
```

**兼容性**: 原 `Attachment.path` 字段改为可选，已有代码中 `path` 赋值仍有效，无破坏性变更。

---

### Task 2: 媒体服务层骨架 (P0)

**新建目录**: `packages/core/src/media/`

#### 2.1 constants.ts — 常量定义

```typescript
/** 单文件最大字节数 (5MB，对标 OpenClaw) */
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;

/** 临时文件 TTL (2分钟，对标 OpenClaw DEFAULT_TTL_MS) */
export const MEDIA_TTL_MS = 2 * 60 * 1000;

/** 媒体存储根目录 */
export const MEDIA_STORE_DIR = ".super-agent/media";

/** MEDIA: 标记正则 (对标 OpenClaw MEDIA_TOKEN_RE) */
export const MEDIA_TOKEN_RE = /\bMEDIA:\s*`?([^\s`\n]+)`?/gi;

/** MIME → MediaKind 映射 */
export const MIME_KIND_MAP: Record<string, MediaKind> = {
  "image/": "image",
  "video/": "video",
  "audio/": "audio",
  "application/pdf": "document",
  "application/msword": "document",
  "application/vnd.openxmlformats-officedocument": "document",
  "application/vnd.ms-excel": "document",
};

/** 安全白名单 — 允许读取的基础目录 */
export const SAFE_READ_ROOTS = [
  MEDIA_STORE_DIR,  // 自身存储目录
];
```

#### 2.2 mime.ts — MIME 检测

```typescript
import { lookup } from "mime-types";
import { MediaKind, MIME_KIND_MAP } from "./constants";

/** 根据文件扩展名检测 MIME */
export function detectMimeFromPath(filePath: string): string | undefined;

/** 根据 Buffer magic bytes 检测 MIME (依赖 file-type 库) */
export async function detectMimeFromBuffer(buffer: Buffer): Promise<string | undefined>;

/** 综合 MIME 检测: Buffer magic bytes 优先，回退到扩展名 */
export async function detectMime(options: {
  buffer?: Buffer;
  filePath?: string;
  declaredMime?: string;
}): Promise<string>;

/** MIME → MediaKind 推断 */
export function kindFromMime(mime: string): MediaKind;
```

#### 2.3 parse.ts — MEDIA: 标记解析

```typescript
import { MEDIA_TOKEN_RE } from "./constants";

export interface ParsedMediaOutput {
  /** 去除 MEDIA: 标记后的纯文本 */
  text: string;
  /** 提取出的媒体 URL/路径列表 */
  mediaUrls: string[];
}

/** 从 Agent 输出中分离 MEDIA: 标记和纯文本 */
export function splitMediaFromOutput(raw: string): ParsedMediaOutput;

/** 检测字符串是否包含 MEDIA: 标记 */
export function hasMediaTokens(text: string): boolean;
```

#### 2.4 security.ts — 安全守卫

```typescript
/** 路径安全验证错误 */
export class MediaSecurityError extends Error {
  constructor(
    public code: "path-traversal" | "symlink" | "ssrf" | "size-exceeded" | "mime-blocked",
    message: string
  ) { super(message); }
}

/** 路径白名单验证 — 防止路径遍历攻击 */
export async function assertPathAllowed(
  filePath: string,
  allowedRoots: string[]
): Promise<void>;

/** SSRF 防护 — 拒绝内网地址 */
export function assertNotInternalUrl(url: string): void;

/** 文件大小检查 */
export function assertSizeAllowed(
  size: number,
  maxBytes?: number
): void;

/** MIME 类型验证 — 拒绝可执行文件等危险类型 */
export function assertMimeAllowed(mime: string): void;
```

#### 2.5 store.ts — 本地临时存储

```typescript
import { MediaDescriptor } from "../types";

export interface SavedMedia {
  /** 存储后的本地路径 */
  path: string;
  /** UUID 标识 */
  id: string;
  /** MIME 类型 */
  contentType: string;
  /** 文件大小 */
  size: number;
}

/** 初始化存储目录 (确保 inbound/outbound 子目录存在) */
export async function initMediaStore(): Promise<void>;

/**
 * 保存 Buffer 到本地临时存储
 * - UUID 命名防冲突 (对标 OpenClaw randomUUID)
 * - 写入前自动清理过期文件
 * - 并发安全: 目录被清理后自动重建重试
 */
export async function saveMediaBuffer(
  buffer: Buffer,
  contentType: string,
  subdir?: "inbound" | "outbound",
  maxBytes?: number,
  originalFilename?: string
): Promise<SavedMedia>;

/**
 * 从 URL 下载并保存
 * - 流式下载 + 大小限制检查
 * - 自动 MIME 嗅探 (16KB 前缀检测)
 */
export async function saveMediaFromUrl(
  url: string,
  subdir?: "inbound" | "outbound",
  maxBytes?: number
): Promise<SavedMedia>;

/** TTL 自动清理过期文件 (对标 OpenClaw cleanOldMedia) */
export async function cleanExpiredMedia(ttlMs?: number): Promise<void>;
```

#### 2.6 loader.ts — 统一媒体加载器

```typescript
import { Attachment, MediaDescriptor } from "../types";

export interface LoadMediaOptions {
  /** 安全白名单目录列表 */
  allowedRoots?: string[];
  /** 最大文件字节数 */
  maxBytes?: number;
  /** 是否自动压缩图片 */
  autoCompress?: boolean;
}

/**
 * 统一媒体加载入口 — 对标 OpenClaw loadWebMedia
 *
 * 支持 3 种来源:
 * 1. URL (http/https) → 下载 + SSRF 防护
 * 2. 本地路径 → 读取 + 白名单校验
 * 3. Base64 → 解码 + MIME 检测
 *
 * 自动完成:
 * - MEDIA: 前缀剥离
 * - MIME 嗅探 (magic bytes + 扩展名)
 * - MediaKind 推断
 * - 文件名推断
 * - 大小限制校验
 */
export async function loadMedia(
  source: string | Attachment,
  options?: LoadMediaOptions
): Promise<MediaDescriptor>;

/**
 * 出站附件解析 — 对标 OpenClaw resolveOutboundAttachmentFromUrl
 * 加载 → 保存到 outbound → 返回本地路径
 */
export async function resolveOutboundAttachment(
  source: string | Attachment,
  options?: LoadMediaOptions
): Promise<SavedMedia>;
```

#### 2.7 index.ts — 统一导出

```typescript
export * from "./types";
export * from "./constants";
export * from "./mime";
export * from "./parse";
export * from "./security";
export * from "./store";
export * from "./loader";
```

---

### Task 3: API 层媒体端点 (P0)

**目标文件**: `packages/api/src/routes/media.ts` (新建)

```typescript
// POST /api/media/upload — 接收 multipart 上传，返回 mediaId
// GET  /api/media/:id    — 按 ID 获取已保存的媒体信息
// GET  /api/media/:id/download — 下载媒体文件
```

**注册路由**: 修改 `packages/api/src/routes/index.ts`，挂载 `/api/media` 路由。

---

### Task 4: 增强 bridge.py 结构化附件处理 (P1)

**目标文件**: `services/im-gateway/bridge.py`

**修改内容**:

1. **新增 `classify_media_kind()` 函数** — 根据 MIME/扩展名推断媒体分类

```python
MIME_KIND_MAP = {
    "image/": "image",
    "video/": "video",
    "audio/": "audio",
    "application/pdf": "document",
    "application/msword": "document",
    "application/vnd.openxmlformats": "document",
    "application/vnd.ms-excel": "document",
}

def classify_media_kind(file_path: str, mime_type: str = "") -> str:
    """根据 MIME 和扩展名推断媒体分类"""
    if not mime_type:
        mime_type, _ = mimetypes.guess_type(file_path)
    for prefix, kind in MIME_KIND_MAP.items():
        if mime_type and mime_type.startswith(prefix):
            return kind
    return "file"
```

2. **新增 `validate_attachment()` 函数** — 文件存在性/大小/路径安全校验

```python
MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024  # 5MB

def validate_attachment(path: str) -> tuple[bool, str]:
    """校验附件安全性，返回 (is_valid, error_message)"""
    if not os.path.isfile(path):
        return False, f"文件不存在: {path}"
    real = os.path.realpath(path)
    if real != os.path.abspath(path):  # symlink 检查
        return False, f"不允许符号链接: {path}"
    size = os.path.getsize(real)
    if size > MAX_ATTACHMENT_BYTES:
        return False, f"文件超过 5MB 限制: {size} bytes"
    return True, ""
```

3. **增强 `send_message()` 方法** — 返回结构化附件列表而非文本拼接

```python
@dataclass
class BridgeReply:
    """桥接回复 — 结构化返回文本和附件"""
    text: str
    attachments: list[dict]  # [{path, kind, mimeType, filename}]
```

---

### Task 5: 渠道媒体适配器 (P1)

**新建目录**: `services/im-gateway/adapters/`

#### 5.1 base.py — 抽象基类

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass

@dataclass
class MediaPayload:
    """渠道发送用的媒体数据"""
    path: str
    kind: str         # image/video/audio/document/file
    mime_type: str
    filename: str
    caption: str = ""

class ChannelMediaAdapter(ABC):
    """渠道媒体适配器抽象基类 — 对标 OpenClaw 渠道扩展模式"""

    @abstractmethod
    async def upload_media(self, payload: MediaPayload) -> str:
        """上传媒体到渠道平台，返回 media_id"""
        ...

    @abstractmethod
    async def send_media(self, chat_id: str, payload: MediaPayload) -> bool:
        """向指定聊天发送媒体"""
        ...

    def supports_kind(self, kind: str) -> bool:
        """检查渠道是否支持该媒体类型"""
        return kind in ("image", "video", "audio", "document", "file")
```

#### 5.2 wecom.py — 企业微信适配器

```python
class WeComMediaAdapter(ChannelMediaAdapter):
    """
    企业微信媒体适配器
    - 图片: upload_media → send_image
    - 文件: upload_media → send_file
    - 视频: upload_media → send_video
    - 语音: upload_media → send_voice (AMR格式限制)
    """
```

#### 5.3 feishu.py — 飞书适配器

```python
class FeishuMediaAdapter(ChannelMediaAdapter):
    """
    飞书媒体适配器
    - 图片: upload_image API → im/v1/images
    - 文件: upload_file API → im/v1/files
    - 音视频: 转为文件发送
    """
```

#### 5.4 dingtalk.py — 钉钉适配器

```python
class DingTalkMediaAdapter(ChannelMediaAdapter):
    """
    钉钉媒体适配器
    - 图片: media/upload → OA消息 / 工作通知
    - 文件: media/upload → 文件消息
    - 语音/视频: 需转为文件类型
    """
```

---

### Task 6: Runtime 媒体处理管道增强 (P2)

**目标文件**: `packages/core/src/agent/runtime.ts`

**修改内容**:

1. 在 `chatStream()` 响应处理阶段，自动检测 LLM 输出中的 `MEDIA:` 标记
2. 调用 `splitMediaFromOutput()` 分离文本和媒体引用
3. 对每个媒体引用调用 `resolveOutboundAttachment()` 进行加载、验证、存储
4. 将解析后的附件追加到响应的 `attachments[]` 字段

```typescript
// runtime.ts chatStream 增强伪代码
import { splitMediaFromOutput, resolveOutboundAttachment } from "../media";

// 在拼接完整 LLM 回复后：
const parsed = splitMediaFromOutput(fullReply);
if (parsed.mediaUrls.length > 0) {
  const resolvedAttachments: Attachment[] = [];
  for (const mediaUrl of parsed.mediaUrls) {
    try {
      const saved = await resolveOutboundAttachment(mediaUrl);
      resolvedAttachments.push({
        path: saved.path,
        mimeType: saved.contentType,
        filename: path.basename(saved.path),
        kind: kindFromMime(saved.contentType),
        size: saved.size,
      });
    } catch (err) {
      logger.warn(`Failed to resolve media: ${mediaUrl}`, err);
    }
  }
  // 合并到已有的工具产出附件
  attachments.push(...resolvedAttachments);
}
// 返回给前端/IM的文本使用 parsed.text (已去除 MEDIA: 标记)
```

---

### Task 7: 前端附件处理解耦 (P2)

**目标文件**: `packages/web/src/app/chat/page.tsx`

**修改内容**:

1. 移除 `readFileAsText()` / `readFileAsBase64()` 前端文件读取逻辑
2. 改为通过 `POST /api/media/upload` 上传文件，获取 `mediaId`
3. 发送消息时传递 `mediaId` 列表而非内联内容
4. 保留 `isTextFile` / `isParseableFile` 仅用于 UI 图标展示

---

## 四、依赖变更

| 包 | 新增依赖 | 用途 |
|----|----------|------|
| `packages/core` | `file-type@^19` | Magic bytes MIME 检测 |
| `packages/core` | `mime-types@^2.1` | 扩展名 MIME 查询 |
| `packages/api` | `multer@^1.4` 或 `formidable@^3` | Multipart 上传处理 |
| `services/im-gateway` | `python-magic` (可选) | Python 侧 MIME 检测 |

---

## 五、安全规格

### 5.1 路径安全 (对标 OpenClaw local-media-access.ts)

- **白名单目录**: 仅允许读取 `MEDIA_STORE_DIR` 和用户配置的工作区目录
- **Realpath 校验**: `fs.realpath()` 解析后必须在白名单内，拒绝 symlink 逃逸
- **路径遍历拒绝**: 拒绝包含 `..` 的路径
- **Windows 网络路径拒绝**: 拒绝 `\\` 开头的 UNC 路径

### 5.2 SSRF 防护

- 拒绝 `127.0.0.1`、`localhost`、`10.*`、`172.16-31.*`、`192.168.*` 等内网地址
- 仅允许 `http://` 和 `https://` 协议

### 5.3 大小限制

- 单文件: `MEDIA_MAX_BYTES = 5MB`
- 流式下载时实时检查已接收字节数
- API 上传层面同步限制 (`multer` 的 `limits.fileSize`)

### 5.4 MIME 安全

- 拒绝可执行类型: `.exe`, `.bat`, `.sh`, `.ps1`, `.dll`
- 双重验证: 扩展名 MIME + magic bytes MIME 必须一致
- 白名单模式: 仅允许 图片/音视频/PDF/Office 文档 通过

---

## 六、实施路线图

### 第 1 周: P0 — 核心媒体层

| 天 | 任务 | 交付物 |
|----|------|--------|
| D1 | Task 1: 类型系统增强 | `types/index.ts` 新增 MediaKind, 增强 Attachment |
| D1-D2 | Task 2.1-2.3: constants + mime + parse | 3 个模块 + 单元测试 |
| D3 | Task 2.4: security 安全守卫 | security.ts + 单元测试 |
| D4 | Task 2.5: store 临时存储 | store.ts + TTL 清理 + 单元测试 |
| D5 | Task 2.6-2.7: loader 统一加载器 + index 导出 | loader.ts + index.ts + 集成测试 |

**验收标准**:
- `loadMedia()` 能正确加载 URL / 本地路径 / Base64 三种来源
- `saveMediaBuffer()` 能 UUID 落盘 + TTL 清理
- `assertPathAllowed()` 能拦截路径遍历
- 所有模块 100% 单元测试覆盖

### 第 2 周: P0+P1 — API 端点 + bridge.py 增强

| 天 | 任务 | 交付物 |
|----|------|--------|
| D1-D2 | Task 3: API 媒体端点 | `/api/media/upload` + `/api/media/:id` |
| D3-D4 | Task 4: bridge.py 增强 | classify_media_kind + validate_attachment + BridgeReply |
| D5 | 集成测试 | API → Core → bridge 全链路验证 |

**验收标准**:
- `POST /api/media/upload` 能接收 multipart 文件并返回 mediaId
- `bridge.py` 返回结构化 `BridgeReply` 而非纯文本
- bridge 附件处理包含大小/路径/MIME 校验

### 第 3 周: P1 — 渠道适配器

| 天 | 任务 | 交付物 |
|----|------|--------|
| D1 | Task 5.1: 抽象基类 | `adapters/base.py` |
| D2 | Task 5.2: 企业微信适配器 | `adapters/wecom.py` + 测试 |
| D3 | Task 5.3: 飞书适配器 | `adapters/feishu.py` + 测试 |
| D4 | Task 5.4: 钉钉适配器 | `adapters/dingtalk.py` + 测试 |
| D5 | adapter_manager.py 集成 | 适配器注册 + 路由 + 端到端测试 |

**验收标准**:
- 3 个渠道适配器均实现 `upload_media` + `send_media`
- `adapter_manager.py` 能根据 platform 自动路由到正确适配器
- 每个适配器处理 5 种 MediaKind (image/video/audio/document/file)

### 第 4 周: P2 — Runtime 管道 + 前端解耦

| 天 | 任务 | 交付物 |
|----|------|--------|
| D1-D2 | Task 6: Runtime 媒体管道 | runtime.ts MEDIA: 自动解析 |
| D3-D4 | Task 7: 前端附件解耦 | page.tsx 改为 API 上传模式 |
| D5 | 全量集成测试 + 回归 | 端到端验证 + 性能基准 |

**验收标准**:
- LLM 输出中的 `MEDIA:` 标记自动解析为结构化附件
- 前端不再直接读取文件内容，统一通过 API 上传
- 全链路: page.tsx → API → Core → Runtime → bridge → adapter 打通

---

## 七、文件变更清单

| 操作 | 文件路径 | 说明 |
|------|----------|------|
| **新建** | `packages/core/src/media/constants.ts` | 常量定义 |
| **新建** | `packages/core/src/media/types.ts` | 媒体类型 (如不在 types/index.ts 中) |
| **新建** | `packages/core/src/media/mime.ts` | MIME 检测 |
| **新建** | `packages/core/src/media/parse.ts` | MEDIA: 标记解析 |
| **新建** | `packages/core/src/media/security.ts` | 安全守卫 |
| **新建** | `packages/core/src/media/store.ts` | 临时存储 |
| **新建** | `packages/core/src/media/loader.ts` | 统一加载器 |
| **新建** | `packages/core/src/media/index.ts` | 统一导出 |
| **新建** | `packages/api/src/routes/media.ts` | 媒体 API 端点 |
| **新建** | `services/im-gateway/adapters/__init__.py` | 适配器包 |
| **新建** | `services/im-gateway/adapters/base.py` | 抽象基类 |
| **新建** | `services/im-gateway/adapters/wecom.py` | 企业微信 |
| **新建** | `services/im-gateway/adapters/feishu.py` | 飞书 |
| **新建** | `services/im-gateway/adapters/dingtalk.py` | 钉钉 |
| **修改** | `packages/core/src/types/index.ts` | 增强 Attachment |
| **修改** | `packages/core/src/index.ts` | 导出 media 模块 |
| **修改** | `packages/api/src/routes/index.ts` | 注册 media 路由 |
| **修改** | `services/im-gateway/bridge.py` | 结构化附件处理 |
| **修改** | `services/im-gateway/adapter_manager.py` | 集成渠道适配器 |
| **修改** | `packages/core/src/agent/runtime.ts` | MEDIA: 自动处理管道 |
| **修改** | `packages/web/src/app/chat/page.tsx` | 前端上传解耦 |

---

## 八、测试策略

### 8.1 单元测试 (packages/core/src/__tests__/media/)

| 模块 | 测试要点 |
|------|----------|
| `mime.test.ts` | PNG/JPEG/PDF/DOCX 的 magic bytes 检测; MIME → Kind 推断 |
| `parse.test.ts` | 混合文本+MEDIA:标记解析; 空输入/纯文本/多标记场景 |
| `security.test.ts` | 路径遍历拦截; symlink 拒绝; SSRF 内网 IP 拒绝; 大小超限 |
| `store.test.ts` | UUID 命名无冲突; TTL 清理; 并发写入安全; 目录自动创建 |
| `loader.test.ts` | URL/本地路径/Base64 三种加载; MEDIA: 前缀剥离; 自动 MIME 检测 |

### 8.2 集成测试

| 场景 | 验证内容 |
|------|----------|
| API 上传 | multipart 上传 → 存储 → 返回 mediaId → 可下载 |
| 端到端附件 | 发消息带附件 → runtime 处理 → bridge 返回 → 渠道发送 |
| MEDIA: 标记 | LLM 输出含标记 → 自动解析 → 结构化附件 → IM 分发 |
| 安全拦截 | 路径遍历/SSRF/超大文件 → 被拦截且不影响主流程 |

### 8.3 渠道适配器测试

- 使用 Mock Server 模拟企业微信/飞书/钉钉 API
- 验证图片/文件/视频/语音的上传和发送
- 验证 API 错误时的降级和重试行为

---

## 九、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| `file-type` 依赖兼容性 | 构建失败 | 使用 CJS 兼容版本或自实现 magic bytes 检测 |
| 渠道 API 限制 (文件大小/格式) | 发送失败 | 适配器内做格式转换 (如 HEIC→JPEG) |
| 并发文件写入竞态 | 文件损坏 | 对标 OpenClaw retryAfterRecreatingDir 重试机制 |
| 临时文件目录权限 | 读写失败 | 启动时 initMediaStore + 权限检查 |
| Attachment 接口变更 | 旧代码兼容 | path 改为可选但保留，增量添加新字段 |

---

## 十、附录

### A. OpenClaw 参考文件索引

| 文件 | 关键函数 | 参考用途 |
|------|----------|----------|
| `openclaw/src/media/web-media.ts` | `loadWebMediaInternal()` | 统一加载器实现 |
| `openclaw/src/media/store.ts` | `saveMediaBuffer()` | 存储管理 + TTL 清理 |
| `openclaw/src/media/parse.ts` | `splitMediaFromOutput()` | MEDIA: 标记解析 |
| `openclaw/src/media/local-media-access.ts` | `assertLocalMediaAllowed()` | 白名单路径校验 |
| `openclaw/src/infra/outbound/message-action-params.ts` | `hydrateAttachmentPayload()` | 附件水合管道 |
| `openclaw/src/infra/outbound/message-action-runner.ts` | `handleSendAction()` | 媒体源收集 |
| `openclaw/extensions/feishu/src/media.test.ts` | `sendMediaFeishu()` | 飞书渠道参考 |

### B. 渠道 API 限制参考

| 渠道 | 图片限制 | 文件限制 | 语音限制 |
|------|----------|----------|----------|
| 企业微信 | 10MB, JPG/PNG | 20MB | 2MB, AMR |
| 飞书 | 10MB, JPG/PNG/GIF | 30MB | opus/mp3 |
| 钉钉 | 5MB, JPG/PNG | 20MB | AMR |
