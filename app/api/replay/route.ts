import presentationData from "../../../data/presentation.json";
import lock from "../../../data/final/DATASET_LOCK.json";
import { replayAudit } from "../../../src/presentation_logic.mjs";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const appName = typeof body.app === "string" ? body.app : "";
  const record = presentationData.apps.find((item) => item.app === appName);
  if (!record) return Response.json({ error: "App not found in the frozen dataset." }, { status: 404 });
  return Response.json(replayAudit(record, lock));
}
