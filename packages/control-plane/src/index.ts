export {
	type AgentAsking,
	agentMayNot,
	COMMANDS,
	type Command,
	type CommandContext,
	completions,
	endedIn,
	isCommand,
	isShell,
	money,
	runCommand,
	SHELL_TIMEOUT_MS,
	shellOutput,
	shellScript,
} from "./commands.ts";
export { ConfigError, type LoadedConfig, loadConfig, parseConfig } from "./config.ts";
// What a prompt calls the directory it is standing in, for the same reason and under the same
// terms: both consoles have a `!` mode now, and a mode that named the same directory two ways
// would be two modes.
export { here } from "./console.ts";
export {
	ControlClient,
	ControlError,
	type Dial,
	dialLocal,
	RELAY_HELLO,
} from "./control-client.ts";
export {
	type AgentConfig,
	type AgentSummary,
	ControlPlane,
	type ControlPlaneOptions,
	type PlaneEvent,
} from "./control-plane.ts";
export {
	CLI_CHANNEL,
	CONTROL_SOCKET_FILE,
	type ControlRequest,
	type ControlResponse,
	ControlServer,
	type ControlServerOptions,
	controlSocketPath,
} from "./control-server.ts";
export { LogFeed } from "./feed.ts";
export {
	AddedGrants,
	type GrantOrigin,
	type GrantStanding,
	originOf,
	reachGrant,
	reachId,
	readHost,
} from "./grants.ts";
export { ProviderKeys } from "./keys.ts";
// A pure reading of how much of a half-written markdown line is settled. Exported because a second
// console — one that draws to a browser rather than a terminal — has to stop in the same place, and
// a copy of it there can only be held honest by a test that can hold both.
export { safeEnd } from "./markdown.ts";
export {
	hostOf,
	type McpServer,
	McpShelf,
	type NamedServer,
	type ReadServer,
	readName,
	readServer,
	type ServerStanding,
	written,
} from "./mcp.ts";
export {
	AddedModels,
	type Catalog,
	KEY_PLACEHOLDER,
	type Model,
	type ModelChoice,
	ModelChoices,
	type ModelOffer,
	type ModelSpec,
	type ModelStanding,
	modelEnv,
	modelGrants,
	offersOf,
	PROVIDERS,
	type Provider,
	type ProviderStanding,
	providersOf,
	resolveModel,
} from "./models.ts";
export { type AgentStep, PiOutput, type PiOutputOptions } from "./pi-output.ts";
export {
	PI_SOCKET_PATH,
	PiSessionChannel,
	type PiSessionChannelOptions,
	RELAY_PATH,
} from "./pi-session.ts";
export {
	nameFor,
	PLUGINS,
	type Plugin,
	pluginAt,
	pluginOf,
	SHELVES,
	type Shelf,
	serverOf,
} from "./plugins.ts";
export {
	checkRepo,
	GITHUB_TOKEN_ENV,
	HeldRepos,
	looksLikeGithubToken,
	type RepoHold,
	type RepoSpec,
	type RepoStanding,
	readPush,
	readRepo,
	repoGrants,
	reposPrompt,
} from "./repos.ts";
export { nameRefused, type Room, roomChannel, roomIn } from "./rooms.ts";
export { type EnsureSelfRepoOptions, ensureSelfRepo } from "./self.ts";
export { overheard, Transcript, type Utterance } from "./transcript.ts";
export {
	type AttachedStream,
	type ByteTransport,
	type ByteTransportFactory,
	type ByteTransportHandlers,
	createExecTransportFactory,
	type ExecTransportOptions,
} from "./transport.ts";
export {
	createTurnHandler,
	MOST_ASKED,
	PiTurnRunner,
	type PiTurnRunnerOptions,
	parseAsked,
	type ReplyRouter,
	TurnError,
	type TurnHandlerOptions,
	type TurnResult,
	type TurnRunner,
	type TurnSandbox,
} from "./turn.ts";
