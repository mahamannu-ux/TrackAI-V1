export type SeedSession = {
  externalId: string;
  gitAiId: string | null;
  name: string;
  tool: string;
  observedModels: string[];
  status: 'shipped' | 'abandoned';
  usage?: {
    model: string;
    input: number;
    output: number;
    reasoning: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    cost: number;
    unit: string;
  };
};

export type SeedCommit = {
  sha: string;
  subject: string;
  added: number;
  deleted: number;
  ai: number;
  human: number;
  unknown: number;
  sessions: Array<{ externalId: string; ai: number }>;
  files: Array<{ path: string; ai: number; human: number; ranges: unknown[] }>;
};

export const task1Sessions: SeedSession[] = [
  {
    externalId: 'ses_07aa4025cffeURaVSPGxAfguCM', gitAiId: 's_d7913cc8561ed7',
    name: 'Formatter, calculator, and model-switch work', tool: 'opencode',
    observedModels: ['nemotron-3-ultra-free'], status: 'shipped',
    usage: { model: 'nemotron-3-ultra-free', input: 231438, output: 2156,
      reasoning: 707, cacheRead: 430592, cacheWrite: 0, cost: 0, unit: 'USD' },
  },
  {
    externalId: 'ses_07a1c47abffephpQ4FrncIti3t', gitAiId: 's_3532371011b8f2',
    name: 'Edit exact division after restart', tool: 'opencode',
    observedModels: ['deepseek-v4-flash-free'], status: 'shipped',
    usage: { model: 'deepseek-v4-flash-free', input: 27352, output: 230,
      reasoning: 86, cacheRead: 54400, cacheWrite: 0, cost: 0, unit: 'USD' },
  },
  {
    externalId: 'ses_07a1937c0ffeDn6Z6K6DQAJLEb', gitAiId: null,
    name: 'Token-consuming abandoned conversation', tool: 'opencode',
    observedModels: ['deepseek-v4-flash-free'], status: 'abandoned',
    usage: { model: 'deepseek-v4-flash-free', input: 26920, output: 143,
      reasoning: 26, cacheRead: 0, cacheWrite: 0, cost: 0, unit: 'USD' },
  },
  {
    externalId: 'ses_07a17fbeeffeMox897zWuPD5ru', gitAiId: 's_3a98f03a2a9503',
    name: 'Architecture session identity change', tool: 'opencode',
    observedModels: ['deepseek-v4-flash-free'], status: 'shipped',
    usage: { model: 'deepseek-v4-flash-free', input: 27276, output: 243,
      reasoning: 181, cacheRead: 54400, cacheWrite: 0, cost: 0, unit: 'USD' },
  },
  {
    externalId: '5c23eb69-1244-4861-9791-1fe81b4d3c44', gitAiId: 's_59e27b7ca6e50b',
    name: 'Copilot multi-file attribution experiment', tool: 'github-copilot',
    observedModels: ['gpt-5.6-luna-free-auto'], status: 'shipped',
    usage: { model: 'gpt-5.6-luna-free-auto', input: 17766, output: 1040,
      reasoning: null, cacheRead: null, cacheWrite: null,
      cost: 3.359415, unit: 'Copilot credits' },
  },
  {
    externalId: 'ses_079104c4bffeztNJEBnIvGIMfi', gitAiId: 's_780a5d47862737',
    name: 'Synthetic usage event test', tool: 'opencode',
    observedModels: ['deepseek-v4-flash-free'], status: 'shipped',
    usage: { model: 'deepseek-v4-flash-free', input: 27477, output: 328,
      reasoning: 0, cacheRead: 54652, cacheWrite: 0, cost: 0, unit: 'USD' },
  },
  {
    externalId: 'ses_0757df1e1ffeoIOg7wRM3T2ih7', gitAiId: 's_052ab4c6396dd6',
    name: 'Cross-clone attribution override test', tool: 'opencode',
    observedModels: ['deepseek-v4-flash-free'], status: 'shipped',
  },
];

export const task1Commits: SeedCommit[] = [
  { sha: 'cca056788573c26e606212dbf8a25172d6532ba9', subject: 'Add owner and delta formatters',
    added: 7, deleted: 0, ai: 4, human: 3, unknown: 0,
    sessions: [{ externalId: 'ses_07aa4025cffeURaVSPGxAfguCM', ai: 4 }],
    files: [{ path: 'src/formatter.py', ai: 4, human: 3, ranges: [
      { startLine: 13, endLine: 15, authorType: 'human' },
      { startLine: 16, endLine: 19, authorType: 'ai' },
    ] }] },
  { sha: 'f37c925ec6ff3839a10b3e327e45e2ef9d2bf5bf', subject: 'Add exact division support',
    added: 9, deleted: 2, ai: 8, human: 1, unknown: 0,
    sessions: [{ externalId: 'ses_07aa4025cffeURaVSPGxAfguCM', ai: 8 }],
    files: [
      { path: 'src/calculator.py', ai: 4, human: 0, ranges: [{ startLine: 14, endLine: 17, authorType: 'ai' }] },
      { path: 'tests/test_calculator.py', ai: 4, human: 0, ranges: [{ startLine: 7, endLine: 7, authorType: 'ai' }, { startLine: 20, endLine: 22, authorType: 'ai' }] },
      { path: 'config/settings.json', ai: 0, human: 1, ranges: [{ startLine: 6, endLine: 6, authorType: 'human' }] },
    ] },
  { sha: '4644a2df034ec326787552c8eafa8a90d3037d1f', subject: 'Handle division errors and signed formatting',
    added: 10, deleted: 0, ai: 10, human: 0, unknown: 0,
    sessions: [{ externalId: 'ses_07aa4025cffeURaVSPGxAfguCM', ai: 10 }],
    files: [
      { path: 'src/formatter.py', ai: 4, human: 0, ranges: [{ startLine: 20, endLine: 23, authorType: 'ai' }] },
      { path: 'src/calculator.py', ai: 2, human: 0, ranges: [{ startLine: 17, endLine: 18, authorType: 'ai' }] },
      { path: 'tests/test_calculator.py', ai: 4, human: 0, ranges: [{ startLine: 23, endLine: 26, authorType: 'ai' }] },
    ] },
  { sha: '6a0934127fcc1d1908d60bb3ce9a3d1147739582', subject: 'Track restarted and cross-agent sessions',
    added: 6, deleted: 1, ai: 6, human: 0, unknown: 0,
    sessions: [
      { externalId: 'ses_07a1c47abffephpQ4FrncIti3t', ai: 1 },
      { externalId: 'ses_07a17fbeeffeMox897zWuPD5ru', ai: 1 },
      { externalId: '5c23eb69-1244-4861-9791-1fe81b4d3c44', ai: 4 },
    ], files: [
      { path: 'src/calculator.py', ai: 1, human: 0, ranges: [{ startLine: 19, endLine: 19, authorType: 'ai' }] },
      { path: 'docs/architecture.md', ai: 1, human: 0, ranges: [{ startLine: 8, endLine: 8, authorType: 'ai' }] },
      { path: 'README.md', ai: 4, human: 0, ranges: [{ startLine: 18, endLine: 21, authorType: 'ai' }] },
    ] },
  { sha: 'babc2ea33e4a85b0c982cfab57faa40434b9c687', subject: 'Enable attribution audit mode',
    added: 1, deleted: 0, ai: 0, human: 1, unknown: 0, sessions: [],
    files: [{ path: 'config/settings.json', ai: 0, human: 1,
      ranges: [{ startLine: 4, endLine: 4, authorType: 'human' }] }] },
  { sha: '0a655a55a268dda75e622d040acdf2eb18e50d42', subject: 'Record synthetic usage event test',
    added: 1, deleted: 0, ai: 1, human: 0, unknown: 0,
    sessions: [{ externalId: 'ses_079104c4bffeztNJEBnIvGIMfi', ai: 1 }],
    files: [{ path: 'docs/architecture.md', ai: 1, human: 0,
      ranges: [{ startLine: 9, endLine: 9, authorType: 'ai' }] }] },
  { sha: '117bbcf644ec287b2ebd7127bf1d2e370dd9c394', subject: 'Test cloned attribution overrides',
    added: 6, deleted: 2, ai: 4, human: 1, unknown: 1,
    sessions: [{ externalId: 'ses_0757df1e1ffeoIOg7wRM3T2ih7', ai: 4 }],
    files: [
      { path: 'src/calculator.py', ai: 4, human: 0, ranges: [{ startLine: 20, endLine: 23, authorType: 'ai' }] },
      { path: 'src/formatter.py', ai: 0, human: 1, ranges: [{ startLine: 23, endLine: 23, authorType: 'human' }] },
    ] },
];
