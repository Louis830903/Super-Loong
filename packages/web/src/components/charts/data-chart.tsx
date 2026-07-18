"use client";

import { useEffect, useRef } from "react";
import Chart from "chart.js/auto";

interface DataChartProps {
  data: any[];
  chartType: "line" | "bar" | "pie" | "scatter";
  title: string;
  xAxis: string;
  yAxis: string;
}

export function DataChart({ data, chartType, title, xAxis, yAxis }: DataChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;

    // 销毁旧图表
    if (chartRef.current) {
      chartRef.current.destroy();
    }

    const labels = data.map(d => d[xAxis]);
    const values = data.map(d => d[yAxis]);

    chartRef.current = new Chart(canvasRef.current, {
      type: chartType,
      data: {
        labels,
        datasets: [{
          label: title,
          data: values,
          backgroundColor: "rgba(54, 162, 235, 0.5)",
          borderColor: "rgba(54, 162, 235, 1)",
          borderWidth: 1,
        }],
      },
      options: {
        responsive: true,
        plugins: {
          title: {
            display: true,
            text: title,
          },
        },
      },
    });

    return () => {
      if (chartRef.current) {
        chartRef.current.destroy();
      }
    };
  }, [data, chartType, title, xAxis, yAxis]);

  return <canvas ref={canvasRef} />;
}
