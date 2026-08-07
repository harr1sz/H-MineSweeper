import { SOLO_COMBO_WINDOW_MS } from "../lib/solo-combo";

interface ComboStatusProps {
  readonly count: number;
  readonly tier: number;
  readonly label: string;
  readonly message: string;
  readonly lastIncrementAtMs: number | null;
}

export function ComboStatus({
  count,
  tier,
  label,
  message,
  lastIncrementAtMs,
}: ComboStatusProps) {
  return (
    <div className="flow-combo-slot">
      {tier > 0 && (
        <div
          key={count}
          className={`flow-combo combo-${tier}`}
          aria-live="polite"
          aria-atomic="true"
        >
          <span>{label}</span>
          <strong>×{count}</strong>
          <em>{message}</em>
          <div className="flow-combo-progress" aria-hidden="true">
            <div
              key={`${count}-${lastIncrementAtMs}`}
              style={{ animationDuration: `${SOLO_COMBO_WINDOW_MS}ms` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
