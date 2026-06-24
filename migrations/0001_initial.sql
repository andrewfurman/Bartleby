CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  twilio_call_sid TEXT UNIQUE,
  elevenlabs_conversation_id TEXT UNIQUE,
  agent_id TEXT,
  agent_name TEXT,
  caller_number TEXT,
  called_number TEXT,
  direction TEXT,
  status TEXT,
  allowlist_result TEXT,
  started_at TEXT,
  ended_at TEXT,
  duration_secs INTEGER,
  summary TEXT,
  transcript_text TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  analysis_json TEXT NOT NULL DEFAULT '{}',
  initiation_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_calls_twilio_call_sid ON calls (twilio_call_sid);
CREATE INDEX IF NOT EXISTS idx_calls_conversation_id ON calls (elevenlabs_conversation_id);
CREATE INDEX IF NOT EXISTS idx_calls_started_at ON calls (started_at);
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls (status);

CREATE TABLE IF NOT EXISTS twilio_events (
  id TEXT PRIMARY KEY,
  twilio_call_sid TEXT,
  event_type TEXT,
  call_status TEXT,
  caller_number TEXT,
  called_number TEXT,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_twilio_events_call_sid ON twilio_events (twilio_call_sid);
CREATE INDEX IF NOT EXISTS idx_twilio_events_occurred_at ON twilio_events (occurred_at);

CREATE TABLE IF NOT EXISTS transcript_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  elevenlabs_conversation_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  role TEXT,
  message TEXT,
  time_in_call_secs REAL,
  tool_calls_json TEXT NOT NULL DEFAULT '[]',
  tool_results_json TEXT NOT NULL DEFAULT '[]',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (elevenlabs_conversation_id, turn_index)
);

CREATE INDEX IF NOT EXISTS idx_transcript_turns_conversation_id ON transcript_turns (elevenlabs_conversation_id);

CREATE TABLE IF NOT EXISTS tool_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  elevenlabs_conversation_id TEXT NOT NULL,
  turn_index INTEGER,
  event_type TEXT NOT NULL,
  tool_name TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_tool_events_conversation_id ON tool_events (elevenlabs_conversation_id);
CREATE INDEX IF NOT EXISTS idx_tool_events_tool_name ON tool_events (tool_name);
