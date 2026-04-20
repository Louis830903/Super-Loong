"use client";

import { useEffect, useState, useCallback } from "react";
import { onToast, type ToastType } from "@/lib/utils";
import { X, AlertCircle, CheckCircle, Info } from "lucide-react";

interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

let nextId = 0;

export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((message: string, type: ToastType) => {
    const id = nextId++;
    setToasts((prev) => [...prev.slice(-4), { id, message, type }]); // keep max 5
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  useEffect(() => {
    return onToast(addToast);
  }, [addToast]);

  const dismiss = (id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 w-80">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`flex items-start gap-3 rounded-xl border px-4 py-3 shadow-lg backdrop-blur-sm animate-in slide-in-from-right-5 fade-in duration-200 ${
            toast.type === "error"
              ? "border-red-800/50 bg-red-950/90 text-red-200"
              : toast.type === "success"
              ? "border-green-800/50 bg-green-950/90 text-green-200"
              : "border-blue-800/50 bg-blue-950/90 text-blue-200"
          }`}
        >
          {toast.type === "error" ? (
            <AlertCircle className="h-5 w-5 shrink-0 mt-0.5 text-red-400" />
          ) : toast.type === "success" ? (
            <CheckCircle className="h-5 w-5 shrink-0 mt-0.5 text-green-400" />
          ) : (
            <Info className="h-5 w-5 shrink-0 mt-0.5 text-blue-400" />
          )}
          <p className="flex-1 text-sm leading-snug">{toast.message}</p>
          <button
            onClick={() => dismiss(toast.id)}
            className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
