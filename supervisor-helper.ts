import { GitpodClient, GitpodServer, GitpodServiceImpl } from '@gitpod/gitpod-protocol/lib/gitpod-service';
import { Disposable, DisposableCollection } from '@gitpod/gitpod-protocol/lib/util/disposable';
import { InfoServiceClient } from '@gitpod/supervisor-api-grpc/lib/info_grpc_pb';
import { WorkspaceInfoRequest } from '@gitpod/supervisor-api-grpc/lib/info_pb';
import { NotificationServiceClient } from '@gitpod/supervisor-api-grpc/lib/notification_grpc_pb';
import { StatusServiceClient } from '@gitpod/supervisor-api-grpc/lib/status_grpc_pb';
import { PortsStatus, PortsStatusRequest, PortsStatusResponse } from '@gitpod/supervisor-api-grpc/lib/status_pb';
import { TerminalServiceClient } from '@gitpod/supervisor-api-grpc/lib/terminal_grpc_pb';
import * as grpc from '@grpc/grpc-js';
import EventEmitter from 'node:events';
import * as util from 'util';

export function isGRPCErrorStatus<T extends grpc.status>(err: any, status: T): boolean {
	return err && typeof err === 'object' && 'code' in err && err.code === status;
}

// Adapted from https://github.com/gitpod-io/gitpod-code/blob/master/gitpod-shared/src/gitpodContext.ts#L38
export class SupervisorConnection {
	static readonly deadlines = {
		long: 30 * 1000,
		normal: 15 * 1000,
		short: 5 * 1000
	};
	private readonly addr = process.env.SUPERVISOR_ADDR || 'localhost:22999';
	private readonly clientOptions: Partial<grpc.ClientOptions>;
	readonly metadata = new grpc.Metadata();
	readonly status: StatusServiceClient;
	readonly notification: NotificationServiceClient;
	private readonly info: InfoServiceClient;
	readonly terminal: TerminalServiceClient;

	readonly onDidChangePortStatus = new EventEmitter();

	constructor(
		private context: DisposableCollection,
	) {
		this.clientOptions = {
			'grpc.primary_user_agent': `xtermIDE/v1.0.0`,
		};
		this.status = new StatusServiceClient(this.addr, grpc.credentials.createInsecure(), this.clientOptions);
		this.notification = new NotificationServiceClient(this.addr, grpc.credentials.createInsecure(), this.clientOptions);
		this.info = new InfoServiceClient(this.addr, grpc.credentials.createInsecure(), this.clientOptions);
		this.terminal = new TerminalServiceClient(this.addr, grpc.credentials.createInsecure(), this.clientOptions);

		this.context.push(Disposable.create(() => {
			this.onDidChangePortStatus.removeAllListeners();
		}));
	}

	private _startObservePortsStatus = false;
	startObservePortsStatus() {
		if (this._startObservePortsStatus) {
			return;
		}
		this._startObservePortsStatus = true;

		let run = true;
		let stopUpdates: Function | undefined;
		(async () => {
			while (run) {
				try {
					const req = new PortsStatusRequest();
					req.setObserve(true);
					const evts = this.status.portsStatus(req, this.metadata);
					stopUpdates = evts.cancel.bind(evts);

					await new Promise((resolve, reject) => {
						evts.on('end', resolve);
						evts.on('error', reject);
						evts.on('data', (update: PortsStatusResponse) => {
							const data = update.getPortsList().map(p => p.toObject());
							this.onDidChangePortStatus.emit("update", data);
						});
					});
				} catch (err) {
					if (!isGRPCErrorStatus(err, grpc.status.CANCELLED)) {
						console.error('cannot maintain connection to supervisor', err);
					}
				} finally {
					stopUpdates = undefined;
				}
				await new Promise(resolve => setTimeout(resolve, 1000));
			}
		})();
		this.context.push({
			dispose() {
				run = false;
				if (stopUpdates) {
					stopUpdates();
				}
			}
		});
	}

	async getWorkspaceInfo() {
		const response = await util.promisify(this.info.workspaceInfo.bind(this.info, new WorkspaceInfoRequest(), this.metadata, {
			deadline: Date.now() + SupervisorConnection.deadlines.long
		}))();
		return response.toObject();
	}
}

type UsedGitpodFunction = ['getWorkspace', 'openPort', 'stopWorkspace', 'setWorkspaceTimeout', 'getWorkspaceTimeout', 'getLoggedInUser', 'takeSnapshot', 'waitForSnapshot', 'controlAdmission', 'sendHeartBeat', 'trackEvent', 'getTeams'];
type Union<Tuple extends any[], Union = never> = Tuple[number] | Union;
export type GitpodConnection = Omit<GitpodServiceImpl<GitpodClient, GitpodServer>, 'server'> & {
	server: Pick<GitpodServer, Union<UsedGitpodFunction>>;
};

export async function* getOpenablePorts(): AsyncGenerator<PortsStatus.AsObject[], void, void> {
	const supervisor = new SupervisorConnection(new DisposableCollection());
	supervisor.startObservePortsStatus();

	const internalEventEmitter = new EventEmitter();
	supervisor.onDidChangePortStatus.on("update", (ports: PortsStatus.AsObject[]) => {
		internalEventEmitter.emit("portsUpdated", ports);
	});

	while (true) {
		const ports = await new Promise<PortsStatus.AsObject[]>(resolve => {
			internalEventEmitter.once("portsUpdated", resolve);
		});
		const filtered = ports.filter(port => {
			if (!port.served) {
				return false;
			}

			switch (port.onOpen) {
				case PortsStatus.OnOpenAction.NOTIFY_PRIVATE:
				case PortsStatus.OnOpenAction.IGNORE:
					return false;
				case PortsStatus.OnOpenAction.OPEN_BROWSER:
				case PortsStatus.OnOpenAction.OPEN_PREVIEW:
				case PortsStatus.OnOpenAction.NOTIFY:
				default:
					return true;
			}
		});

		yield filtered;
	}
}
