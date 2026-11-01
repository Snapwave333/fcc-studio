import { useCallback, useEffect, useState } from "react";
import { Gauge, Play, RefreshCw, Trophy, Download, CircleStop } from "lucide-react";
import { api, BenchProgress, listenEvent, RedlineStatus, LeaderboardRow } from "../../lib/api";
import { useApp } from "../../store/useApp";

interface BenchRow {
  task: string;
  score: number;
  max: number;
  latency_ms: number;
  detail: string;
  done: boolean;
}

function Row({ label, value, ok }: { label: string; value: string; ok?: boolean | null }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-panel px-3 py-1.5 text-[12px]">
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${
          ok === undefined || ok === null ? "bg-muted" : ok ? "bg-ok" : "bg-err"
        }`}
      />
      <span className="text-text2">{label}</span>
      <span className="min-w-0 flex-1 truncate text-right text-[11px] text-muted">{value}</span>
    </div>
  );
}

export default function RedlinePane() {
  const showToast = useApp((s) => s.showToast);
  const visible = useApp((s) => s.rightTab === "redline");
  const autonomy = useApp((s) => s.autonomy);
  const activateRedline = useApp((s) => s.activateRedline);
  const deactivateRedline = useApp((s) => s.deactivateRedline);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [busyModel, setBusyModel] = useState<string | null>(null);
  const [status, setStatus] = useState<RedlineStatus | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
  const [benchModel, setBenchModel] = useState<string | null>(null);
  const [benchRows, setBenchRows] = useState<BenchRow[]>([]);
  const [running, setRunning] = useState(false);

  const refresh = useCallback(async () => {
    setLoadingStatus(true);
    const [st, lb, br] = await Promise.all([
      api.redlineStatus().catch(() => null),
      api.redlineLeaderboard().catch(() => []),
      api.redlineBenchRunning().catch(() => false),
    ]);
    setStatus(st);
    setLeaderboard(lb);
    setRunning(br);
    setLoadingStatus(false);
  }, []);

  useEffect(() => {
    if (!visible) return;
    refresh();
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [refresh, visible]);

  useEffect(() => {
    const un = listenEvent<BenchProgress>("redline-bench", (p) => {
      setBenchModel(p.model);
      setBenchRows((rows) => {
        const next = rows.filter((r) => r.task !== p.task);
        next.push({ task: p.task, score: p.score, max: p.max, latency_ms: p.latency_ms, detail: p.detail, done: p.done });
        return next;
      });
      if (p.finished) setRunning(false);
    });
    const unDone = listenEvent<{ model: string; score: number; max: number }>("redline-bench-done", (p) => {
      setRunning(false);
      showToast(`Benchmark finished · ${p.model} scored ${p.score}/${p.max}`);
      refresh();
    });
    return () => {
      un.then((f) => f());
      unDone.then((f) => f());
    };
  }, [refresh, showToast]);

  const activate = async (model: string) => {
    setBusyModel(model);
    const ok = await activateRedline(model);
    setBusyModel(null);
    if (ok) showToast(`Redline ACTIVE — routing through local ${model}. Cloud fallback disabled.`);
    await refresh();
  };

  const deactivate = async () => {
    setBusyModel("off");
    await deactivateRedline();
    setBusyModel(null);
    showToast("Redline OFF — previous model configuration restored");
    await refresh();
  };

  const runBenchmark = async (model: string) => {
    setBenchModel(model);
    setBenchRows([]);
    setRunning(true);
    try {
      await api.redlineBenchmark(model);
    } catch (e) {
      showToast(String(e));
      setRunning(false);
    }
  };

  const hw = status?.hardware;

  return (
    <div className="space-y-4 overflow-y-auto p-3 text-[12px]">
      <div className="flex items-center justify-between">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">redline · local engine</span>
        <button className="btn btn-ghost px-1.5" onClick={refresh} title="Refresh">
          <RefreshCw size={13} className={loadingStatus ? "animate-spin" : ""} />
        </button>
      </div>

      <Row
        label="FCC proxy"
        ok={status?.proxy_up ?? null}
        value={status?.proxy_model ?? "unknown"}
      />
      <Row
        label="Redline mode"
        ok={status?.redline_active ?? false}
        value={status?.redline_active ? `ACTIVE · ${status.redline_model}` : "OFF · cloud config"}
      />
      <Row label="Ollama" ok={status?.ollama_up ?? false} value={status?.ollama_up ? `${status.models.length} models` : "not installed / not running"} />
      <Row label="LM Studio" ok={status?.lmstudio_up ?? false} value={status?.lmstudio_up ? "detected on :1234" : "not detected"} />

      {hw && (
        <>
          <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">hardware</div>
          <Row
            label="GPU"
            value={hw.vram_total_gb > 0 ? `${hw.gpu} · ${hw.vram_used_gb}/${hw.vram_total_gb} GB VRAM` : hw.gpu === "none" ? "no dedicated GPU detected" : hw.gpu}
            ok={hw.gpu !== "none"}
          />
          <Row label="System RAM" value={`${hw.ram_free_gb} / ${hw.ram_total_gb} GB free`} />
          <Row label="Disk" value={`${hw.disk_free_gb} GB free`} ok={hw.disk_free_gb > 10} />
        </>
      )}

      {!status?.ollama_up && (
        <div className="space-y-2 rounded-xl border border-[#22222c] bg-panel p-3">
          <p className="text-[11.5px] leading-relaxed text-muted">
            No local inference engine detected. Install Ollama to run Redline entirely offline. On
            Windows this runs <code className="text-fuchsia2">winget install Ollama.Ollama</code>, on macOS{" "}
            <code className="text-fuchsia2">brew install ollama</code>; otherwise the official download page opens.
          </p>
          <button className="btn btn-primary" onClick={() => api.redlineInstallOllama().then((msg) => showToast(msg)).catch((e) => showToast(String(e)))}>
            <Download size={13} /> Install Ollama
          </button>
        </div>
      )}

      {status?.ollama_up && status.models.length > 0 && (
        <>
          <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">local models</div>
          {status.models.map((m) => (
            <div key={m.name} className="rounded-xl border border-[#22222c] bg-panel p-2.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium text-text2">{m.name}</span>
                {status.redline_model === m.name && <span className="chip bg-fuchsia text-white">ACTIVE</span>}
                <button className="btn btn-ghost px-1.5" title="Benchmark this model" onClick={() => runBenchmark(m.name)} disabled={running}>
                  <Play size={12} />
                </button>
                {status.redline_model !== m.name && (
                  <button className="btn btn-primary px-2 py-0.5" onClick={() => activate(m.name)} disabled={busyModel !== null}>
                    {busyModel === m.name ? "…" : status.redline_active ? "Switch" : "Use"}
                  </button>
                )}
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5 text-[10.5px] text-muted">
                <span className="chip">{m.parameter_size || "?"} params</span>
                <span className="chip">{m.quantization || "?"}</span>
                <span className="chip">{m.size_gb} GB</span>
                {m.context_length > 0 && <span className="chip">ctx {Math.round(m.context_length / 1024)}K</span>}
                {m.capabilities.slice(0, 3).map((c) => (
                  <span key={c} className="chip">{c}</span>
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      {(running || benchRows.length > 0) && (
        <div className="rounded-xl border border-[#22222c] bg-panel p-2.5">
          <div className="mb-1 flex items-center gap-2">
            <Gauge size={13} className={running ? "animate-pulse text-fuchsia" : "text-ok"} />
            <span className="font-medium text-text2">
              benchmark {benchModel ? `· ${benchModel}` : ""} {running ? "running…" : "complete"}
            </span>
          </div>
          {benchRows.map((r) => (
            <div key={r.task} className="flex items-baseline gap-2 py-0.5 text-[11px]" title={r.detail}>
              <span className={!r.done ? "animate-pulse text-fuchsia2" : r.score > 0 ? "text-ok" : "text-err"}>
                {!r.done ? "◌" : r.score > 0 ? "✓" : "✕"}
              </span>
              <span className="w-40 shrink-0 text-text2">{r.task}</span>
              <span className="text-muted">{r.done ? `${r.score}/${r.max}` : "running"}</span>
              <span className="min-w-0 flex-1 truncate text-right text-muted">{r.done ? `${r.latency_ms} ms` : ""}</span>
            </div>
          ))}
        </div>
      )}

      <div>
        <div className="mb-1 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted">
          <Trophy size={12} /> leaderboard (persisted)
        </div>
        {leaderboard.length === 0 ? (
          <div className="px-1 text-[11.5px] text-muted">Run a benchmark to build the leaderboard.</div>
        ) : (
          leaderboard.map((row, i) => (
            <div key={row.model} className="flex items-center gap-2 rounded-lg bg-panel px-2.5 py-1.5 text-[11.5px]">
              <span className="w-4 text-center font-bold text-fuchsia2">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-text2">{row.model}</span>
              <span className="font-mono text-ok">{row.avg_score.toFixed(1)}</span>
              <span className="text-muted">{row.tasks_run} tasks</span>
              <span className="text-muted">{row.avg_latency_ms} ms avg</span>
            </div>
          ))
        )}
      </div>

      {status?.redline_active && autonomy !== "redline" && (
        <p className="px-1 text-[11px] text-muted">
          The proxy is routed locally but the autonomy mode is not Redline — prompts still use the {autonomy} permission profile.
        </p>
      )}
      {status?.redline_active && (
        <button className="btn btn-danger w-full justify-center" onClick={deactivate} disabled={busyModel !== null}>
          <CircleStop size={13} /> Turn Redline OFF (restore cloud config)
        </button>
      )}

      <p className="px-1 text-[10.5px] leading-relaxed text-muted">
        ACTIVE mode points the existing Free Claude Code proxy at the selected local model and clears
        its cloud fallbacks, so no request can silently leave the machine. OFF restores the exact
        previous configuration.
      </p>
    </div>
  );
}
