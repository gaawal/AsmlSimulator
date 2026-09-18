extends SceneTree
## Run from the native project root with --script pointing at this file.
## Captures the existing native process as a regression oracle for the JS port.
const Pipeline = preload("res://scripts/simulation/dual_stage_pipeline.gd")

func _initialize() -> void:
	var runs: Array = []
	for count in [1, 2, 6, 12]:
		var model = Pipeline.new()
		model.set_batch_count(count)
		model.start()
		var samples: Array = []
		var previous := ""
		var guard := 0
		while model.state != "done" and guard < 4000:
			var snapshot: Dictionary = model.snapshot()
			var key := "%s|%s|%s|%d|%d" % [snapshot.machine_phase, snapshot.stages.A.action, snapshot.stages.B.action, snapshot.stages.A.wafer_id, snapshot.stages.B.wafer_id]
			if key != previous:
				var row := {"time": model.elapsed_s, "phase": snapshot.machine_phase, "stages": {}}
				for letter in ["A", "B"]:
					var stage: Dictionary = snapshot.stages[letter]
					row.stages[letter] = {"station": stage.station, "action": stage.action, "wafer_id": stage.wafer_id, "wafer_state": stage.wafer_state}
				samples.append(row)
				previous = key
			model.tick(0.125)
			guard += 1
		var events: Array = []
		for event in model.events:
			events.append({"type": event.type, "actor": event.actor, "time": event.elapsed_s, "wafer_id": event.get("wafer_id", 0)})
		runs.append({"batch": count, "elapsed_s": model.elapsed_s, "exchange_count": model.exchange_count, "completed_ids": model.completed.map(func(w): return w.wafer_id), "samples": samples, "events": events})
	var output := "res://asml-twinscan-web/tests/fixtures/godot-pipeline.json"
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(output).get_base_dir())
	var file := FileAccess.open(output, FileAccess.WRITE)
	file.store_string(JSON.stringify({"engine": Engine.get_version_info().string, "source": "scripts/simulation/dual_stage_pipeline.gd", "sampling_interval_s": 0.125, "runs": runs}, "\t"))
	file.close()
	print("WEB_PORT_REFERENCE: ", ProjectSettings.globalize_path(output))
	quit()
