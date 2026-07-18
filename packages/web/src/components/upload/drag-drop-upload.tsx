"use client";

import { useCallback, useState } from "react";
import { Upload, X } from "lucide-react";

interface DragDropUploadProps {
  onUpload: (files: File[]) => void;
  accept?: string;
  maxSize?: number; // MB
}

export function DragDropUpload({ onUpload, accept = "*", maxSize = 10 }: DragDropUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [files, setFiles] = useState<File[]>([]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const droppedFiles = Array.from(e.dataTransfer.files);
    const validFiles = droppedFiles.filter(file => {
      const sizeMB = file.size / 1024 / 1024;
      return sizeMB <= maxSize;
    });

    setFiles(prev => [...prev, ...validFiles]);
    onUpload(validFiles);
  }, [maxSize, onUpload]);

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  return (
    <div
      className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
        isDragging ? "border-blue-500 bg-blue-50" : "border-gray-300"
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <Upload className="mx-auto h-12 w-12 text-gray-400" />
      <p className="mt-2 text-sm text-gray-600">
        拖拽文件到此处，或点击上传
      </p>
      <p className="text-xs text-gray-500">
        最大 {maxSize}MB
      </p>

      {files.length > 0 && (
        <div className="mt-4 space-y-2">
          {files.map((file, index) => (
            <div key={index} className="flex items-center justify-between bg-gray-100 p-2 rounded">
              <span className="text-sm truncate">{file.name}</span>
              <button onClick={() => removeFile(index)}>
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
