import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  TELEMETRY_AGGREGATE_RETENTION_DAYS,
  TELEMETRY_CONSENT_STORAGE_KEY,
  TELEMETRY_RAW_RETENTION_DAYS,
  TelemetryClient,
  detectBrowserFamily,
  detectDeviceClass,
  type AllowedTelemetryEventName,
  type TelemetryProperty,
  type TelemetrySettingsSnapshot,
} from "../lib/telemetry";
import {
  APP_VERSION,
  TELEMETRY_ENABLED,
} from "../lib/build-config";

interface TelemetryContextValue {
  readonly snapshot: TelemetrySettingsSnapshot;
  readonly track: (
    eventName: AllowedTelemetryEventName,
    properties?: Readonly<Record<string, TelemetryProperty>>,
  ) => boolean;
  readonly flush: (keepalive?: boolean) => Promise<boolean>;
}

const DISABLED_SNAPSHOT: TelemetrySettingsSnapshot = {
  available: false,
  acknowledged: false,
  enabled: false,
  hasDeletionCredential: false,
  queuedEvents: 0,
  error: null,
};

const TelemetryContext = createContext<TelemetryContextValue>({
  snapshot: DISABLED_SNAPSHOT,
  track: () => false,
  flush: async () => false,
});

let appReadyTrackedForPage = false;

function viewportBucket(width: number): string {
  if (width < 360) return "lt_360";
  if (width < 390) return "360_389";
  if (width < 768) return "390_767";
  if (width < 1_280) return "768_1279";
  return "gte_1280";
}

export function useTelemetry(): TelemetryContextValue {
  return useContext(TelemetryContext);
}

interface TelemetryPrivacyProviderProps {
  readonly children: ReactNode;
  readonly enabledByDeployment?: boolean;
  readonly appVersion?: string;
}

export function TelemetryPrivacyProvider({
  children,
  enabledByDeployment = TELEMETRY_ENABLED,
  appVersion = APP_VERSION,
}: TelemetryPrivacyProviderProps) {
  const clientRef = useRef<TelemetryClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = new TelemetryClient({
      enabledByDeployment,
      appVersion,
    });
  }
  const client = clientRef.current;
  const [snapshot, setSnapshot] = useState(client.snapshot());
  const [panelOpen, setPanelOpen] = useState(
    () => snapshot.available && !snapshot.acknowledged,
  );
  const [message, setMessage] = useState("");
  const [runtimeWarning, setRuntimeWarning] = useState("");
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const choiceOperationRef = useRef(0);

  const track = useCallback<TelemetryContextValue["track"]>(
    (eventName, properties = {}) => {
      const accepted = client.track(eventName, properties);
      setSnapshot(client.snapshot());
      return accepted;
    },
    [client],
  );

  const flush = useCallback(
    async (keepalive = false) => {
      const flushed = await client.flush(keepalive);
      setSnapshot(client.snapshot());
      return flushed;
    },
    [client],
  );

  const choose = (enabled: boolean) => {
    const operation = choiceOperationRef.current + 1;
    choiceOperationRef.current = operation;
    setRuntimeWarning("");
    const next = client.acknowledge(enabled);
    const preferenceWrite = client.recordPreference(enabled);
    setSnapshot(next);
    setPanelOpen(false);
    const effectiveEnabled = next.enabled;
    const baseMessage = effectiveEnabled
      ? "假名化产品遥测已开启。你可以随时退出。"
      : "遥测已退出，待发送队列已清除；游戏和本地历史继续可用。";
    setMessage(baseMessage);
    void preferenceWrite.then((recorded) => {
      if (choiceOperationRef.current !== operation) return;
      const current = client.snapshot();
      setSnapshot(current);
      if (!current.acknowledged || current.enabled !== effectiveEnabled) return;
      if (!recorded) {
        const warning =
          `${baseMessage} 服务端未能记录本次开关状态，证据报告会将其列为缺失数据。`;
        setMessage(warning);
        setRuntimeWarning(warning);
      }
    });
  };

  const deferChoice = () => {
    choiceOperationRef.current += 1;
    setRuntimeWarning("");
    setMessage(
      "暂未选择遥测；不会创建遥测会话或采集事件，游戏和本地历史照常可用。",
    );
    setPanelOpen(false);
  };

  useEffect(() => {
    if (!snapshot.enabled || appReadyTrackedForPage) return;
    appReadyTrackedForPage = true;
    track("app_ready", {
      browserFamily: detectBrowserFamily(),
      deviceClass: detectDeviceClass(),
      viewportBucket: viewportBucket(window.innerWidth),
    });
    void client.recordPreference(true).then(() => flush());
  }, [client, flush, snapshot.enabled, track]);

  useEffect(() => {
    if (!snapshot.enabled) return;
    const timer = window.setInterval(() => {
      void client.recordPreference(true).then(() => flush());
    }, 10_000);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void flush(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [client, flush, snapshot.enabled]);

  useEffect(() => {
    const synchronizeConsent = (event: StorageEvent) => {
      if (event.key !== TELEMETRY_CONSENT_STORAGE_KEY) return;
      choiceOperationRef.current += 1;
      const next = client.synchronizeConsentFromStorage();
      setSnapshot(next);
      setRuntimeWarning("");
      if (next.acknowledged) {
        setMessage(
          next.enabled
            ? "另一标签页已开启假名化产品遥测。"
            : "另一标签页已退出遥测；本页待发送队列已清除。",
        );
      }
    };
    window.addEventListener("storage", synchronizeConsent);
    return () => window.removeEventListener("storage", synchronizeConsent);
  }, [client]);

  useEffect(() => {
    if (!panelOpen || !snapshot.available) return;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const dialog = dialogRef.current;
    const initial = dialog?.querySelector<HTMLElement>(
      "[data-privacy-initial-focus]",
    );
    (initial ?? dialog)?.focus();
    return () => {
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    };
  }, [panelOpen, snapshot.available]);

  const handleDialogKeyDown = (
    event: KeyboardEvent<HTMLElement>,
  ) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (snapshot.acknowledged) {
        setPanelOpen(false);
      } else {
        deferChoice();
      }
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) {
      event.preventDefault();
      event.currentTarget.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const deleteRemote = async () => {
    setBusy(true);
    setMessage("");
    try {
      await client.deleteRemoteRawTelemetry();
      setMessage(
        "服务端已接受删除请求。仍在 7 天保留期内、可归属到本设备的原始事件已删除；无安装 ID 的聚合无法回溯到个人。",
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "服务端原始遥测删除请求失败，请稍后重试。",
      );
    } finally {
      setSnapshot(client.snapshot());
      setBusy(false);
    }
  };

  return (
    <TelemetryContext.Provider value={{ snapshot, track, flush }}>
      {children}
      {snapshot.available && (
        <button
          className="privacy-fab"
          type="button"
          aria-haspopup="dialog"
          onClick={() => setPanelOpen(true)}
        >
          数据与隐私
        </button>
      )}
      {snapshot.error && (
        <div className="privacy-runtime-error" role="status">
          {snapshot.error}
        </div>
      )}
      {runtimeWarning && (
        <div className="privacy-runtime-error" role="status">
          {runtimeWarning}
        </div>
      )}
      {panelOpen && snapshot.available && (
        <div className="privacy-backdrop">
          <section
            ref={dialogRef}
            className="privacy-dialog"
            role="dialog"
            tabIndex={-1}
            aria-modal="true"
            aria-labelledby="privacy-title"
            aria-describedby="privacy-description"
            onKeyDown={handleDialogKeyDown}
          >
            <span className="panel-kicker">ALPHA DATA NOTICE</span>
            <h2 id="privacy-title">选择是否分享假名化使用数据</h2>
            <div id="privacy-description">
              <p>
                这些数据只用于判断首局、历史查看、训练复访和失败漏斗。
                它们是<strong>假名化</strong>数据，不是“完全匿名”。
              </p>
              <ul>
                <li>
                  记录：事件名、阶段耗时、设备/浏览器类别、棋盘规格、结果、历史是否保存，
                  以及随机生成的假名化安装标识、访问会话标识和训练会话标识，用于关联同一次训练与复访。
                </li>
                <li>
                  不进入产品遥测或应用日志：昵称、房间码、Token、完整 IP、精确位置、
                  棋盘 seed、雷图、回放或自由文本。网络层只在内存中短暂使用 IP 做限速，
                  不把完整 IP 写入产品遥测或持久日志。
                </li>
                <li>
                  可归属原始事件保留 {TELEMETRY_RAW_RETENTION_DAYS} 天；
                  去除安装 ID 和单人明细的汇总最多保留{" "}
                  {TELEMETRY_AGGREGATE_RETENTION_DAYS} 天。
                </li>
                <li>
                  退出或上传失败都不阻塞游戏；本地历史独立保存，不会随遥测开关改变。
                </li>
                <li>
                  也可以稍后决定；在你明确选择前，遥测保持关闭，且不会创建服务端遥测会话。
                </li>
                <li>
                  无论选择开启或退出，服务端都会尝试记录本次公开会话的开关状态，
                  用于区分明确退出和上传故障；该记录不含安装 ID，也不用于限制产品访问。
                </li>
                <li>
                  公开会话与开关记录包含当前状态、是否曾退出、协议/应用版本和决策时间，
                  最多保留 {TELEMETRY_RAW_RETENTION_DAYS} 天；它们不含安装 ID，
                  不随“删除服务端原始遥测”删除，而是在到期后清理。
                </li>
              </ul>
            </div>
            {message && <div className="privacy-message" role="status">{message}</div>}
            <div className="privacy-actions">
              <button
                className="primary-button"
                type="button"
                data-privacy-initial-focus
                onClick={() => choose(true)}
              >
                继续并开启（默认）
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => choose(false)}
              >
                退出遥测并继续
              </button>
              {!snapshot.acknowledged && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={deferChoice}
                >
                  稍后决定，继续游戏
                </button>
              )}
              {snapshot.acknowledged && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setPanelOpen(false)}
                >
                  关闭
                </button>
              )}
            </div>
            {snapshot.acknowledged && (
              <div className="privacy-controls">
                <p>
                  当前：{snapshot.enabled ? "新事件开启" : "新事件关闭"} ·
                  待发送 {snapshot.queuedEvents} 条
                </p>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => choose(!snapshot.enabled)}
                >
                  {snapshot.enabled ? "停止并清除待发送事件" : "重新开启新事件"}
                </button>
                <button
                  className="secondary-button danger-button"
                  type="button"
                  disabled={busy || !snapshot.hasDeletionCredential}
                  onClick={() => void deleteRemote()}
                >
                  {busy ? "正在提交…" : "删除服务端原始遥测"}
                </button>
                <small>
                  这是服务端遥测删除。单人训练页中的“删除全部历史”只删除本浏览器本地成绩，
                  两者不会互相代替。该操作不删除不含安装 ID 的公开会话/开关记录或匿名汇总；
                  若遥测仍开启，删除后产生的新事件仍会上传。
                </small>
              </div>
            )}
          </section>
        </div>
      )}
    </TelemetryContext.Provider>
  );
}
