# Hoya Agent workflow redesign

This workflow is the target interaction model for the redesigned desktop client. The editable Mermaid source is in `agent-workflow.mmd` and is intentionally compatible with FigJam's flowchart renderer.

## Design intent

- Keep task creation, context assembly, execution, approval, and delivery visible as one continuous Run.
- Treat approval as a paused state instead of a detached queue that silently outlives the task.
- Show the planned tool action and risk before execution, then return a structured result to the same model loop.
- Make cancel available during model streaming, approval, and tool execution.
- Preserve the current stale-response check and max-step fallback before final delivery.

## Implemented workflow

The backend now persists each Run in `.hoya/task_runs.json`, including its context summary, four-stage plan, approval checkpoint, remaining tool calls, and local file versions. Approval no longer returns a synthetic pending result to the model. It pauses the loop; after approval or denial, `resumeRun` appends the real decision result to the original tool call and continues from the saved step.

Workspace text writes create a content snapshot, verify UTF-8 read-back and SHA-256, and validate JSON/Python syntax where applicable. Failed validation is rolled back automatically. A verified version can later be rolled back unless the file has changed again, in which case conflict protection preserves the newer edit.

## UI state mapping

| Runtime event | Desktop state | Primary action |
| --- | --- | --- |
| `run_started` | Running | Stop |
| `status` / `reasoning` | Thinking | Inspect activity |
| `tool_start` | Preparing tool | Review plan |
| `approval_required` | Waiting for approval | Approve or deny |
| `tool_result` | Tool completed | Inspect output |
| `cancelled` | Cancelled | Start a new task |
| `done` | Completed | Continue conversation |

## Figma frame recommendations

- Desktop canvas: 1280 x 820.
- Minimum supported desktop canvas: 980 x 640.
- Main application frame: navigation 276, workbench fluid, run panel 348.
- Use Segoe UI Variable where available, with PingFang SC or Microsoft YaHei for Chinese fallback.
- Use component variants for Run status, approval risk, icon button state, and inspector tab state.
