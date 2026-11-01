import { useCallback, useEffect, useState } from "react";
import { Copy, FolderOpen, RefreshCw } from "lucide-react";
import { api, AppInfo, ElevationStatus, EnvInfo, RelayStatus } from "../../lib/api";
import { useApp } from "../../store/useApp";

function Row({ label, ok, detail }: { label: string; ok: boolean | null; detail?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-panel px-3 py-2">
      <span className={`h-2 w-2 shrink-0 rounded-full ${ok === null ? "bg-muted" : ok ? "bg-ok" : "bg-err"}`} />
      <span className="shrink-0 text-[12.5px] text-text2">{label}</span>
      <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-muted" title={detail}>
        {detail ?? ""}
      </span>
    </div>
  );
}

const OS_NAME: Record<string, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };

export default function EnvPane() {
  const showToast = useApp((s) => s.showToast);
  const visible = useApp((s) => s.rightTab === "env");
  const [env, setEnv] = useState<EnvInfo | null>(null);
  const [relay, setRelay] = useState<RelayStatus | null>(null);
  const [elev, setElev] = useState<ElevationStatus | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [audit, setAudit] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [e, r, el, a, i] = await Promise.all([
      api.detectEnvironment().catch(() => null),
      api.relayStatus().catch(() => null),
      api.elevationStatus().catch(() => null),
      api.auditRead().catch(() => []),
      api.appInfo().catch(() => null),
    ]);
    setEnv(e);
    setRelay(r);
    setElev(el);
    setAudit(a);
    setInfo(i);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!visible) return;
    refresh();
    const t = setInterval(() => {
      api.relayStatus().then(setRelay).catch(() => {});
      api.auditRead().then(setAudit).catch(() => {});
    }, 10000);
    return () => clearInterval(t);
  }, [visible, refresh]);

  const osName = OS_NAME[info?.os ?? env?.os ?? ""] ?? info?.os ?? "";

  return (
    <div className="h-full space-y-4 overflow-y-auto p-3 text-[12px]">
      <div className="flex items-center justify-between">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">environment</span>
        <button className="btn btn-ghost px-1.5" onClick={refresh} title="Re-scan">
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <Row
        label="Free Claude Code"
        ok={env ? !!env.fcc_claude : null}
        detail={env ? (env.fcc_claude ? env.fcc_version || env.fcc_claude : "fcc-claude not found on PATH") : "scanning…"}
      />
      <Row label="Claude Code CLI" ok={env ? !!env.claude : null} detail={env ? env.claude_version || env.claude || "not found" : ""} />
      <Row label="Git" ok={env ? !!env.git : null} detail={env?.git ?? (env ? "not found" : "")} />
      <Row label="Node" ok={env ? !!env.node : null} detail={env?.node ?? (env ? "not found" : "")} />
      <Row label="Terminal shell" ok={env ? true : null} detail={env?.default_shell ?? ""} />

      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">chrome relay</div>
      <Row label="Broker 127.0.0.1:4098" ok={relay?.broker_up ?? null} detail={relay ? (relay.broker_up ? "connected" : "offline") : ""} />
      <Row label="Relay config (~/.relay)" ok={relay?.config_found ?? null} detail={relay ? (relay.config_found ? "found" : "missing") : ""} />
      <Row label="browser-relay CLI" ok={relay?.browser_relay_cli ?? null} detail={relay ? (relay.browser_relay_cli ? "on PATH" : "not found") : ""} />
      <p className="px-1 text-[11px] leading-relaxed text-muted">
        With the Relay MCP server enabled in your Claude Code config, the agent gets authenticated browser tools (navigate,
        snapshot, click, screenshot) directly.
      </p>

      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">autonomy · privileges</div>
      <Row
        label="Process privileges"
        ok={elev ? !elev.is_admin : null}
        detail={elev ? (elev.is_admin ? (elev.os === "windows" ? "Administrator" : "root") : `standard user (${elev.user})`) : "unknown"}
      />
      {elev && !elev.is_admin && (
        <div className="space-y-1.5 rounded-xl border border-[#22222c] bg-panel p-3">
          {elev.can_request ? (
            <>
              <p className="text-[11px] leading-relaxed text-muted">
                YOLO mode can run with Administrator privileges. Windows shows a UAC prompt and launches an elevated copy of
                Serenity; this window keeps running.
              </p>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  try {
                    await api.requestElevation();
                    showToast("UAC prompt sent — approve it to run elevated");
                  } catch (e) {
                    showToast(String(e));
                  }
                }}
              >
                Request Administrator elevation
              </button>
            </>
          ) : (
            <p className="text-[11px] leading-relaxed text-muted">
              On {osName || "this OS"} Serenity runs with your user's permissions. To give the agent root, start Serenity from a
              root shell — this is intentionally not automated.
            </p>
          )}
        </div>
      )}

      <div className="flex items-center text-[10.5px] font-semibold uppercase tracking-wider text-muted">
        <span className="flex-1">audit log (secrets redacted)</span>
        {audit.length > 0 && (
          <button
            className="flex items-center gap-1 normal-case hover:text-text"
            onClick={() => navigator.clipboard?.writeText(audit.join("\n")).then(() => showToast("Audit log copied"))}
          >
            <Copy size={11} /> copy
          </button>
        )}
      </div>
      <div className="max-h-52 overflow-y-auto rounded-xl border border-[#22222c] bg-[#0c0c10] p-2 font-mono text-[10.5px] leading-relaxed text-muted">
        {audit.length === 0 ? "No audited actions yet." : audit.map((l, i) => <div key={i}>{l}</div>)}
      </div>

      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">about</div>
      <div className="space-y-1.5 rounded-xl border border-[#22222c] bg-panel p-3 text-[11px] leading-relaxed text-muted">
        <p>
          <span className="font-semibold text-text2">Serenity {info?.version ?? ""}</span>
          {info ? ` · ${osName} ${info.arch}` : ""}
        </p>
        <p>
          A local-first desktop workspace for Free Claude Code. Model routing, the fallback cascade and provider configuration
          live in the CLI and are never duplicated here. Projects, conversations, memory, benchmarks and window layout are stored
          locally and restored on every launch.
        </p>
        {info?.data_dir && (
          <button
            className="btn btn-ghost -ml-2 px-2 py-0.5 text-[11px]"
            title={info.data_dir}
            onClick={() => api.openInExplorer(info.data_dir).catch((e) => showToast(String(e)))}
          >
            <FolderOpen size={12} /> Open data folder
          </button>
        )}
      </div>
    </div>
  );
}
