"use client";

import { useState } from "react";
import { Search, X } from "lucide-react";

interface MessageSearchProps {
  onSearch: (query: string) => void;
  onClose: () => void;
}

export function MessageSearch({ onSearch, onClose }: MessageSearchProps) {
  const [query, setQuery] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(query);
  };

  return (
    <div className="border-b border-gray-200 p-4">
      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <Search className="h-5 w-5 text-gray-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索消息..."
          className="flex-1 border-none outline-none"
        />
        <button type="button" onClick={onClose}>
          <X className="h-5 w-5 text-gray-400" />
        </button>
      </form>
    </div>
  );
}
