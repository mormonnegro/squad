export {
	appPasswordPage,
	baseAddress,
	type Closed,
	closedTo,
	discover,
	domainOf,
	type Incoming,
	needsBridge,
	openDomain,
} from "./autoconfig.ts";
export { type Channel, ChannelError, ChannelRouter, type Reply } from "./channel.ts";
export {
	type Account,
	addressFor,
	EmailChannel,
	type EmailChannelOptions,
	type EmailPublisher,
	type ReadMark,
	type Session,
} from "./email.ts";
export {
	addressesIn,
	admits,
	agentFor,
	asOperator,
	authenticated,
	automated,
	isOwnAddress,
	type MailHeaders,
	parseAddress,
	readableText,
	type Sender,
	tooWide,
	withoutTrail,
} from "./mail.ts";
export { asHtml } from "./markup.ts";
export {
	CARRIERS,
	type Call,
	type Carrier,
	type CarrierSpec,
	type Carrying,
	carry,
	resolveCarrier,
} from "./outbox.ts";
export { pairingPhrase } from "./phrase.ts";
export { isFresh, SIGNATURE_HEADER, sign, TIMESTAMP_HEADER, verify } from "./signature.ts";
export {
	asked,
	authentic,
	type Delivery,
	deliveryIn,
	isSigner,
	type Presented,
	SIGNER_SAID,
	SIGNERS,
	type Signer,
	signedHeaders,
} from "./signer.ts";
export {
	type Bot,
	type BotIdentity,
	intoMessages,
	startLink,
	TelegramChannel,
	type TelegramChannelOptions,
	type TelegramPublisher,
} from "./telegram.ts";
export {
	DEFAULT_MOST_A_MINUTE,
	type Hook,
	type Seen,
	WebhookChannel,
	type WebhookChannelOptions,
	type WebhookPublisher,
} from "./webhook.ts";
