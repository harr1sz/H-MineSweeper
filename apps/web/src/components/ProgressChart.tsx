import { useEffect, useRef } from "react";

export interface ProgressPoint {
  elapsedMs: number;
  players: Record<string, number>;
}

interface ProgressChartProps {
  history: ProgressPoint[];
  playerIds: string[];
  labels: Record<string, string>;
}

export function ProgressChart({ history, playerIds, labels }: ProgressChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    const width = rect.width;
    const height = rect.height;
    context.clearRect(0, 0, width, height);
    context.strokeStyle = "#263241";
    context.lineWidth = 1;
    for (let line = 1; line < 4; line += 1) {
      const y = (height / 4) * line;
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }

    if (history.length === 0) return;
    const maxTime = Math.max(1, history.at(-1)?.elapsedMs ?? 1);
    const colors = ["#f7c66a", "#63a8ff"];
    playerIds.slice(0, 2).forEach((playerId, playerIndex) => {
      context.strokeStyle = colors[playerIndex] ?? "#ffffff";
      context.lineWidth = 2;
      context.beginPath();
      history.forEach((point, index) => {
        const x = (point.elapsedMs / maxTime) * width;
        const progress = point.players[playerId] ?? 0;
        const y = height - (progress / 100) * height;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
    });
  }, [history, playerIds]);

  return (
    <div className="progress-chart">
      <div className="chart-legend" aria-hidden="true">
        {playerIds.slice(0, 2).map((playerId, index) => (
          <span key={playerId}>
            <i className={`legend-swatch swatch-${index + 1}`} />
            {labels[playerId] ?? `P${index + 1}`}
          </span>
        ))}
      </div>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="本局双方安全格完成进度曲线"
      />
    </div>
  );
}
