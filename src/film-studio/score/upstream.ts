/*
 * Thin adapter around the vendored StageFlow core (MIT, see
 * ../vendor/stageflow-core/NOTICE.md). Feature code imports these wrappers
 * instead of reaching into the vendor folder, so an upstream update is one
 * place, and so our UI can migrate from the local subset engine module by
 * module without a big-bang switch.
 */
export {parseStageScore as parseUpstreamScore} from "../vendor/stageflow-core/scoreParser";
export {computeStageFrame as computeUpstreamFrame} from "../vendor/stageflow-core/frameEngine";
export type {StageScore as UpstreamStageScore, StageFrame as UpstreamStageFrame, EvaluatedCameraTrack as UpstreamCameraTrack, EvaluatedEntityState as UpstreamEntityState} from "../vendor/stageflow-core/types";
