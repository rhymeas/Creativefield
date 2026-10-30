import { LinkButton } from "../ds";
import { Download, Route } from "lucide-react";
import { exportRunRecord, type RunRecord } from "../runs/records";

function executionLabel(record: RunRecord): string {
  if (record.execution.route === "native-comfy") return "Native ComfyUI workflow";
  if (record.execution.route === "api-via-comfy") return `${record.execution.service} API via ComfyUI`;
  return "Execution route unknown";
}

function evidenceLabel(record: RunRecord): string {
  return record.captureSource === "studio-submission"
    ? "Recorded when ComfyUI accepted this job"
    : "Inferred from a matching graph in ComfyUI history";
}

function inputSummary(record: RunRecord): string {
  const values = [
    record.effectiveParams.startImage && `start: ${record.effectiveParams.startImage}`,
    record.effectiveParams.endImage && `end: ${record.effectiveParams.endImage}`,
    record.effectiveParams.motionVideo && `motion: ${record.effectiveParams.motionVideo}`,
    record.enhance?.sourceVideo && `source: ${record.enhance.sourceVideo}`,
  ].filter(Boolean);
  return values.join(" · ") || "No uploaded input file";
}

export function RunDetails({ record }: { record: RunRecord | undefined }) {
  if (!record) return null;
  const exported = exportRunRecord(record);
  const href = `data:application/json;charset=utf-8,${encodeURIComponent(exported)}`;
  return (
    <section className="ds-run" aria-label="Run provenance">
      <div className="ds-run__heading"><Route size={13} /> Run provenance</div>
      <dl className="ds-run__list">
        <div><dt>Execution</dt><dd>{executionLabel(record)}</dd></div>
        <div><dt>Evidence</dt><dd>{evidenceLabel(record)}</dd></div>
        <div><dt>Prompt ID</dt><dd className="ds-run__mono">{record.promptId}</dd></div>
        <div><dt>Provider</dt><dd>{record.providerId} · {record.pipeline}</dd></div>
        <div><dt>Effective settings</dt><dd>{record.effectiveParams.aspect} · seed {record.effectiveParams.seed}{record.effectiveParams.durationSec > 0 ? ` · ${record.effectiveParams.durationSec.toFixed(1)}s` : ""}</dd></div>
        <div><dt>Inputs</dt><dd>{inputSummary(record)}</dd></div>
        {record.observation.output && <div><dt>Output reference</dt><dd className="ds-run__mono">{record.observation.output.subfolder ? `${record.observation.output.subfolder}/` : ""}{record.observation.output.filename}</dd></div>}
        {record.fingerprints?.graphSha256 && <div><dt>Graph fingerprint</dt><dd className="ds-run__mono" title={record.fingerprints.graphSha256}>{record.fingerprints.graphSha256.slice(0, 16)}…</dd></div>}
      </dl>
      <div className="ds-run__foot">
        <span>Saved in this browser; media remains in ComfyUI.</span>
        <LinkButton variant="ghost" href={href} download={`run-${record.promptId}.json`}>
          <Download size={12} /> Export record
        </LinkButton>
      </div>
    </section>
  );
}
