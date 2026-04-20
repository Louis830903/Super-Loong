"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/utils";
import {
  Bot,
  MessageSquare,
  Radio,
  Puzzle,
  Activity,
  Clock,
  Plug,
  Shield,
  Users,
  Brain,
} from "lucide-react";

interface HealthData {
  status: string;
  uptime: number;
  agents: number;
  sessions: number;
  gateway: string;
}

function StatCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  color: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
      <div className="flex items-center gap-3">
        <div className={`rounded-lg p-2 ${color}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-sm text-zinc-400">{label}</p>
          <p className="text-2xl font-bold text-white">{value}</p>
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch<HealthData>("/api/system/health")
      .then(setHealth)
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">仪表盘</h1>
        <p className="mt-1 text-zinc-400">系统运行状态总览</p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 p-4 text-red-400">
          API 连接失败：{error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={Activity}
          label="系统状态"
          value={health?.status === "ok" ? "运行中" : "未知"}
          color="bg-green-600/20 text-green-400"
        />
        <StatCard
          icon={Bot}
          label="活跃 Agent"
          value={health?.agents ?? "-"}
          color="bg-blue-600/20 text-blue-400"
        />
        <StatCard
          icon={MessageSquare}
          label="活跃会话"
          value={health?.sessions ?? "-"}
          color="bg-purple-600/20 text-purple-400"
        />
        <StatCard
          icon={Clock}
          label="运行时间"
          value={
            health
              ? `${Math.floor(health.uptime / 60)}m ${Math.floor(health.uptime % 60)}s`
              : "-"
          }
          color="bg-amber-600/20 text-amber-400"
        />
      </div>

      {/* Quick Actions */}
      <div>
        <h2 className="mb-4 text-lg font-semibold text-white">快速操作</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <QuickAction
            href="/agents"
            icon={Bot}
            title="创建 Agent"
            desc="配置一个新的 AI Agent"
          />
          <QuickAction
            href="/chat"
            icon={MessageSquare}
            title="开始对话"
            desc="与 Agent 进行对话测试"
          />
          <QuickAction
            href="/channels"
            icon={Radio}
            title="接入通道"
            desc="连接微信、飞书等 IM 平台"
          />
          <QuickAction
            href="/skills"
            icon={Puzzle}
            title="管理技能"
            desc="添加或编辑 Agent 技能"
          />
          <QuickAction
            href="/memory"
            icon={Brain}
            title="查看记忆"
            desc="管理 Agent 持久记忆"
          />
          <QuickAction
            href="/mcp"
            icon={Plug}
            title="MCP 工具"
            desc="管理 MCP 服务器和工具"
          />
          <QuickAction
            href="/cron"
            icon={Clock}
            title="定时任务"
            desc="配置 Cron 定时调度"
          />
          <QuickAction
            href="/collaboration"
            icon={Users}
            title="多 Agent 协作"
            desc="Crew 编排和 GroupChat"
          />
          <QuickAction
            href="/security"
            icon={Shield}
            title="安全管理"
            desc="凭证保管和审计日志"
          />
        </div>
      </div>
    </div>
  );
}

function QuickAction({
  href,
  icon: Icon,
  title,
  desc,
}: {
  href: string;
  icon: React.ElementType;
  title: string;
  desc: string;
}) {
  return (
    <a
      href={href}
      className="group flex items-start gap-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 transition-colors hover:border-zinc-700 hover:bg-zinc-900"
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-zinc-400 group-hover:text-blue-400" />
      <div>
        <p className="font-medium text-white">{title}</p>
        <p className="mt-1 text-sm text-zinc-500">{desc}</p>
      </div>
    </a>
  );
}
