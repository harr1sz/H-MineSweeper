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
import {
  LocaleToggle,
  useLocale,
  type MessageDescriptor,
  type MessageId,
} from "../i18n";

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
  const { t } = useLocale();
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
  const [message, setMessage] = useState<MessageDescriptor | null>(null);
  const [runtimeWarning, setRuntimeWarning] =
    useState<MessageDescriptor | null>(null);
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
    setRuntimeWarning(null);
    const next = client.acknowledge(enabled);
    const preferenceWrite = client.recordPreference(enabled);
    setSnapshot(next);
    setPanelOpen(false);
    const effectiveEnabled = next.enabled;
    const baseMessageId: MessageId = effectiveEnabled
      ? "privacy.enabledMessage"
      : "privacy.disabledMessage";
    setMessage({ id: baseMessageId });
    void preferenceWrite.then((recorded) => {
      if (choiceOperationRef.current !== operation) return;
      const current = client.snapshot();
      setSnapshot(current);
      if (!current.acknowledged || current.enabled !== effectiveEnabled) return;
      if (!recorded) {
        const warningId: MessageId = effectiveEnabled
          ? "privacy.enabledPreferenceMissing"
          : "privacy.disabledPreferenceMissing";
        setMessage({ id: warningId });
        setRuntimeWarning({ id: warningId });
      }
    });
  };

  const deferChoice = () => {
    choiceOperationRef.current += 1;
    setRuntimeWarning(null);
    setMessage({ id: "privacy.deferredMessage" });
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
      setRuntimeWarning(null);
      if (next.acknowledged) {
        setMessage({
          id: next.enabled
            ? "privacy.otherTabEnabled"
            : "privacy.otherTabDisabled",
        });
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
    setMessage(null);
    try {
      await client.deleteRemoteRawTelemetry();
      setMessage({ id: "privacy.deleteAccepted" });
    } catch {
      setMessage({ id: "privacy.deleteFailed" });
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
          {t("privacy.open")}
        </button>
      )}
      {snapshot.error && (
        <div className="privacy-runtime-error" role="status">
          {t("privacy.runtimeError")}
        </div>
      )}
      {runtimeWarning && (
        <div className="privacy-runtime-error" role="status">
          {t(runtimeWarning.id, runtimeWarning.values)}
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
            <span className="panel-kicker">{t("privacy.kicker")}</span>
            <h2 id="privacy-title">{t("privacy.title")}</h2>
            <div id="privacy-description">
              <p>
                {t("privacy.introBefore")}
                <strong>{t("privacy.pseudonymous")}</strong>
                {t("privacy.introAfter")}
              </p>
              <ul>
                <li>{t("privacy.records")}</li>
                <li>{t("privacy.excludes")}</li>
                <li>
                  {t("privacy.retention", {
                    rawDays: TELEMETRY_RAW_RETENTION_DAYS,
                    aggregateDays: TELEMETRY_AGGREGATE_RETENTION_DAYS,
                  })}
                </li>
                <li>{t("privacy.nonBlocking")}</li>
                <li>{t("privacy.deferExplanation")}</li>
                <li>{t("privacy.preferenceRecord")}</li>
                <li>
                  {t("privacy.publicSessionRetention", {
                    rawDays: TELEMETRY_RAW_RETENTION_DAYS,
                  })}
                </li>
              </ul>
            </div>
            {message && (
              <div className="privacy-message" role="status">
                {t(message.id, message.values)}
              </div>
            )}
            <div className="privacy-actions">
              <LocaleToggle className="secondary-button privacy-language-toggle" />
              <button
                className="primary-button"
                type="button"
                data-privacy-initial-focus
                onClick={() => choose(true)}
              >
                {t("privacy.enable")}
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => choose(false)}
              >
                {t("privacy.disable")}
              </button>
              {!snapshot.acknowledged && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={deferChoice}
                >
                  {t("privacy.defer")}
                </button>
              )}
              {snapshot.acknowledged && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setPanelOpen(false)}
                >
                  {t("privacy.close")}
                </button>
              )}
            </div>
            {snapshot.acknowledged && (
              <div className="privacy-controls">
                <p>
                  {snapshot.enabled
                    ? t("privacy.currentEnabled")
                    : t("privacy.currentDisabled")} ·{" "}
                  {t("privacy.queued", { count: snapshot.queuedEvents })}
                </p>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => choose(!snapshot.enabled)}
                >
                  {snapshot.enabled ? t("privacy.stop") : t("privacy.restart")}
                </button>
                <button
                  className="secondary-button danger-button"
                  type="button"
                  disabled={busy || !snapshot.hasDeletionCredential}
                  onClick={() => void deleteRemote()}
                >
                  {busy ? t("privacy.deleting") : t("privacy.deleteRemote")}
                </button>
                <small>
                  {t("privacy.deleteExplanation")}
                </small>
              </div>
            )}
          </section>
        </div>
      )}
    </TelemetryContext.Provider>
  );
}
