import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, EnvInfo, RelayStatus } from "../../lib/api";
import { useApp } from "../../store/useApp";

function Row({ label, ok, detail }: { label: string; ok: boolean | null; detail?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-panel px-3 py-2">
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${
          ok === null ? "bg-muted" : ok ? "bg-ok" : "bg-err"
        }`}
      />
      <span className="text-[12.5px] text-text2">{label}</span>
      <span className="min-w-0 flex-1 truncate text-right text-[11px] text-muted">{detail ?? ""}</span>
    </div>
  );
}

export default function EnvPane() {
  const showToast = useApp((s) => s.showToast);
  const [env, setEnv] = useState<EnvInfo | null>(null);
  const [relay, setRelay] = useState<RelayStatus | null>(null);
  const [elev, setElev] = useState<{ is_admin: boolean; user: string } | null>(null);
  const [audit, setAudit] = useState<string[]>([]);

  const refresh = async () => {
    setEnv(await api.detectEnvironment().catch(() => null));
    setRelay(await api.relayStatus().catch(() => null));
    setElev(await api.elevationStatus().catch(() => null));
    setAudit(await api.auditRead().catch(() => []));
  };

  useEffect(() => {
    refresh();
    const t = setInterval(() => api.relayStatus().then(setRelay).catch(() => {}), 10000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="space-y-4 overflow-y-auto p-3 text-[12px]">
      <div className="flex items-center justify-between">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">environment</span>
        <button className="btn btn-ghost px-1.5" onClick={refresh}>
          <RefreshCw size={13} />
        </button>
      </div>

      <Row
        label="Free Claude Code (fcc-claude)"
        ok={!!env?.fcc_claude}
        detail={env?.fcc_claude ?? "not found on PATH"}
      />
      <Row label="Claude Code CLI" ok={!!env?.claude} detail={env?.claude_version ?? "not found"} />
      <Row label="Git" ok={!!env?.git} detail={env?.git ? "available" : "not found"} />
      <Row label="Node" ok={!!env?.node} detail={env?.node ? "available" : "not found"} />

      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">
        opencode chrome relay
      </div>
      <Row
        label="Broker ws://127.0.0.1:4098"
        ok={relay?.broker_up ?? null}
        detail={relay?.broker_up ? "connected" : "offline"}
      />
      <Row label="Relay config (~/.relay)" ok={relay?.config_found ?? null} />
      <Row label="browser-relay CLI" ok={relay?.browser_relay_cli ?? null} />
      <p className="px-1 text-[11px] leading-relaxed text-muted">
        The agent uses the existing Relay installation for authenticated Chrome automation. Enable its
        MCP server in the Claude Code environment and browser tools (navigate, snapshot, click,
        screenshot, …) become available to the agent directly.
      </p>

      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">autonomy · privileges</div>
      <Row label="Process privileges" ok={elev?.is_admin ?? null} detail={elev ? (elev.is_admin ? "Administrator" : `standard user (${elev.user})`) : "unknown"} />
      {!elev?.is_admin && (
        <div className="space-y-1 rounded-xl border border-[#22222c] bg-panel p-3">
          <p className="text-[11px] leading-relaxed text-muted">
            YOLO mode can operate with Administrator privileges. Elevation requires UAC approval —
            Windows launches an elevated copy of FCC Studio; approve the prompt to allow it.
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
        </div>
      )}

      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">audit log (secrets redacted)</div>
      <div className="max-h-44 overflow-y-auto rounded-xl border border-[#22222c] bg-[#0c0c10] p-2 font-mono text-[10.5px] leading-relaxed text-muted">
        {audit.length === 0 ? "No audited actions yet." : audit.map((l, i) => <div key={i}>{l}</div>)}
      </div>

      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">about</div>
      <p className="px-1 text-[11px] leading-relaxed text-muted">
        FCC Studio is a local-first desktop workspace for Free Claude Code. Model routing, the
        fallback cascade and all provider configuration live inside the CLI and are never duplicated
        here.
      </p>
      <button className="btn btn-ghost w-full justify-center" onClick={() => showToast("Settings are stored per project")}>
        Workspace layout is saved automatically
      </button>
    </div>
  );
}
