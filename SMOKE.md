# Symphony Live Smoke

This smoke verifies the real local-first Symphony path against a disposable,
labelled issue in the configured tracker repository.

## Flow

1. Load and validate `WORKFLOW.md` for a tracked local repository.
2. Poll the tracker and project an eligible issue into the queue.
3. Dispatch the selected item into a deterministic isolated Git worktree.
4. Start the configured coding agent on the existing Symphony branch.
5. Apply the WORKFLOW contract, including approval and validation policy.
6. Run every configured validation command in the worktree.
7. Read `SYMPHONY_EVIDENCE.md` and assemble host-derived evidence.
8. Push the committed branch and create a pull request in the configured repo.
9. Surface the run timeline, evidence, attention state, and review readiness.

## Pass criteria

The run is successful only when the tracker item, isolated workspace, agent
turn, validation results, populated evidence, pushed branch, and real pull
request all agree on the same work item and repository. A terminal run without
a pull-request URL is not a complete delivery smoke.

The smoke must not create a hosted repository or merge the resulting pull
request. Cleanup and merge remain separate, explicitly confirmed operations.
