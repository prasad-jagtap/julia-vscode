/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import * as juliaexepath from './juliaexepath';
import * as readline from 'readline';
import { generatePipeName } from './utils';
import * as net from 'net';
import { uuid } from 'uuidv4';
import { getEnvPath } from './jlpkgenv';
const { Subject } = require('await-notify');

export class JuliaNotebookCell {
	public outputs: vscode.CellOutput[] = [];

	constructor(
		public source: string[],
		public cell_type: 'markdown' | 'code',
		private _outputs: vscode.CellOutput[]
	) {

	}

	containHTML() {
		return this._outputs && this._outputs.some(output => {
			if (output.output_type === 'display_data' && output.data['text/html']) {
				return true;
			}

			return false;
		});
	}

	insertDependencies(dependency: vscode.CellOutput) {
		this._outputs.unshift(dependency);
	}

	fillInOutputs() {
		if (this._outputs && this.outputs.length !== this._outputs.length) {
			this.outputs = this._outputs;
		}
	}

	outputsFullFilled() {
		return this._outputs && this.outputs.length === this._outputs.length;
	}

	clearOutputs() {
		this.outputs = [];
	}
}

export class JuliaNotebook {
	public mapping: Map<number, any> = new Map();
	private request_id_to_cell_handle: Map<number, any> = new Map();
	private preloadScript = false;
	private _terminal: vscode.Terminal;
	private _socket: net.Socket;
	private _current_request_id: number = 0;
	constructor(
		private _extensionPath: string,
		public document: vscode.NotebookDocument,
		editor: vscode.NotebookEditor,
		public notebookJSON: any,
		private fillOutputs: boolean
	) {
		let cells = notebookJSON.cells.map(((raw_cell: any) => {
			let outputs = [];
			if (fillOutputs) {
				outputs = raw_cell.outputs;

				if (!this.preloadScript) {
					let containHTML = this.containHTML(raw_cell);

					if (containHTML) {
						this.preloadScript = true;
						const scriptPathOnDisk = vscode.Uri.file(
							path.join(this._extensionPath, 'dist', 'ipywidgets.js')
						);

						let scriptUri = scriptPathOnDisk.with({ scheme: 'vscode-resource' });

						outputs.unshift(
							{
								'output_type': 'display_data',
								'data': {
									'text/html': [
										`<script src="${scriptUri}"></script>\n`,
									]
								}
							}
						);
					}
				}
			}


			let managedCell = editor.createCell(
				raw_cell.source ? raw_cell.source.join('') : '',
				notebookJSON?.metadata?.language_info?.name ?? 'python',
				raw_cell.cell_type,
				outputs
			);

			this.mapping.set(managedCell.handle, raw_cell);
			return managedCell;
		}));

		editor.document.languages = ['python'];
		editor.document.cells = cells;		
	}

	async startKernel() {
		let connectedPromise = new Subject();
		let serverListeningPromise = new Subject();

		const pn = generatePipeName(uuid(), 'vscode-language-julia-notebook-kernel');

		let server = net.createServer(socket => {
			this._socket = socket;
			const rl = readline.createInterface(socket);

			rl.on('line', line => {
				let cmd_end = line.indexOf(":");
				let cmd = line.slice(undefined, cmd_end);
				let payload = line.slice(cmd_end + 1);

				if (cmd == 'image/png') {
					let parts = payload.split(';');

					let cellHandle = this.request_id_to_cell_handle.get(parseInt(parts[0]));

					console.log(this.document.cells);

					let cell = this.document.cells.find(i=>i.handle==cellHandle);

					if (cell) {
						cell.outputs.unshift({
							'output_type': 'execute_result',
							'data': {
								'image/png': [parts[1]]
							}
						});
					}


					console.log(cell);
				}

				console.log(cmd);
				console.log(payload);
			});

			connectedPromise.notify();
		});

		server.listen(pn, () => {
			serverListeningPromise.notify();
		});

		await serverListeningPromise.wait();

		const jlexepath = await juliaexepath.getJuliaExePath();
		let pkgenvpath = await getEnvPath();

		this._terminal = vscode.window.createTerminal({
			name: "Julia Notebook Kernel",
			shellPath: jlexepath,
			shellArgs: [
				'--color=yes',
				`--project=${pkgenvpath}`,
				'--startup-file=no',
				'--history-file=no',
				path.join(this._extensionPath, 'scripts', 'notebook', 'notebook.jl'),
				pn
			]
		});
		this._terminal.show(false);
		let asdf: Array<vscode.Disposable> = [];
		vscode.window.onDidCloseTerminal((terminal) => {
			if (terminal == this._terminal) {
				asdf[0].dispose();
				this._terminal = undefined;
				this._socket = undefined;
			}
		}, this, asdf);

		await connectedPromise.wait();
	}

	async execute(document: vscode.NotebookDocument, cell: vscode.NotebookCell | undefined) {
		if (!this._terminal) {
			await this.startKernel()	
		}		

		if (cell) {
			let code = cell.getContent();
			let encoded_code = Buffer.from(code).toString('base64')
			this._socket.write(`${this._current_request_id}:${encoded_code}\n`);
			this.request_id_to_cell_handle.set(this._current_request_id, cell.handle);
			this._current_request_id += 1;

			let rawCell = this.mapping.get(cell.handle);

			if (!this.preloadScript) {
				let containHTML = this.containHTML(rawCell);
				if (containHTML) {
					this.preloadScript = true;
					const scriptPathOnDisk = vscode.Uri.file(
						path.join(this._extensionPath, 'dist', 'ipywidgets.js')
					);

					let scriptUri = scriptPathOnDisk.with({ scheme: 'vscode-resource' });

					rawCell.outputs.unshift(
						{
							'output_type': 'display_data',
							'data': {
								'text/html': [
									`<script src="${scriptUri}"></script>\n`,
								]
							}
						}
					);
				}
			}
			cell.outputs = rawCell.outputs;
		} else {
			if (!this.fillOutputs) {
				for (let i = 0; i < document.cells.length; i++) {
					let cell = document.cells[i];

					let rawCell = this.mapping.get(cell.handle);

					if (!this.preloadScript) {
						let containHTML = this.containHTML(rawCell);
						if (containHTML) {
							this.preloadScript = true;
							const scriptPathOnDisk = vscode.Uri.file(
								path.join(this._extensionPath, 'dist', 'ipywidgets.js')
							);

							let scriptUri = scriptPathOnDisk.with({ scheme: 'vscode-resource' });

							rawCell.outputs.unshift(
								{
									'output_type': 'display_data',
									'data': {
										'text/html': [
											`<script src="${scriptUri}"></script>\n`,
										]
									}
								}
							);
						}
					}
					cell.outputs = rawCell.outputs;
				}

				this.fillOutputs = true;
			}
		}
	}

	containHTML(rawCell: any) {
		return rawCell.outputs && rawCell.outputs.some((output: any) => {
			if (output.output_type === 'display_data' && output.data['text/html']) {
				return true;
			}

			return false;
		});
	}
}

export class JuliaNotebookProvider implements vscode.NotebookProvider {
	private _onDidChangeNotebook = new vscode.EventEmitter<{ resource: vscode.Uri; notebook: vscode.NotebookDocument; }>();
	onDidChangeNotebook: vscode.Event<{ resource: vscode.Uri; notebook: vscode.NotebookDocument; }> = this._onDidChangeNotebook.event;
	private _notebooks: Map<string, JuliaNotebook> = new Map();

	constructor(private _extensionPath: string, private fillOutputs: boolean) {
	}

	async resolveNotebook(editor: vscode.NotebookEditor): Promise<void> {
		console.log('DOES THIS HAPPEN?');
		try {
			let content = await vscode.workspace.fs.readFile(editor.document.uri);

			let lines = content.toString().split('\n');
			let json: any = {cells: []};

			let current_md: string[] = [];
			let current_code: string[] = [];
			let inCodeCell = false;

			for (let i in lines) {
				if (lines[i].startsWith('```julia')) {
					inCodeCell = true

					json.cells.push({cell_type: 'markdown', source: current_md})
					current_md = [];
				}
				else if (lines[i].startsWith('```')) {
					inCodeCell = false

					json.cells.push({cell_type: 'code', source: current_code, outputs: []})
					current_code = []
				}
				else if (inCodeCell) {
					current_code.push(lines[i])
				}
				else {
					current_md.push(lines[i])
				}
			}
			if (inCodeCell) {
				json.cells.push({cell_type: 'code', source: current_code, outputs: []})
			}
			else {
				json.cells.push({cell_type: 'markdown', source: current_md})
				
			}
			// try {
			// 	json = JSON.parse(content.toString());
			// } catch {
			// 	json = {
			// 		cells: [{
			// 			cell_type: 'markdown',
			// 			source: [
			// 				'# header'
			// 			]
			// 		}]
			// 	};
			// }
			let jupyterNotebook = new JuliaNotebook(this._extensionPath, editor.document, editor, json, this.fillOutputs);
			this._notebooks.set(editor.document.uri.toString(), jupyterNotebook);
		} catch {

		}
	}

	async executeCell(document: vscode.NotebookDocument, cell: vscode.NotebookCell | undefined): Promise<void> {
		let jupyterNotebook = this._notebooks.get(document.uri.toString());

		if (jupyterNotebook) {
			jupyterNotebook.execute(document, cell);
		}
	}

	async save(document: vscode.NotebookDocument): Promise<boolean> {
		let cells: any[] = [];

		for (let i = 0; i < document.cells.length; i++) {
			let lines = document.cells[i].getContent().split(/\r|\n|\r\n/g);
			let source = lines.map((value, index) => {
				if (index !== lines.length - 1) {
					return value + '\n';
				} else {
					return value;
				}
			});

			if (document.cells[i].cell_type === 'markdown') {
				cells.push({
					source: source,
					metadata: {
						language_info: {
							name: document.cells[i].language ?? 'markdown'
						}
					},
					cell_type: document.cells[i].cell_type
				});
			} else {
				cells.push({
					source: source,
					metadata: {
						language_info: {
							name: document.cells[i].language ?? 'markdown'
						}
					},
					cell_type: document.cells[i].cell_type,
					outputs: []
				});
			}
		}

		let raw = this._notebooks.get(document.uri.toString());

		if (raw) {
			raw.notebookJSON.cells = cells;
			let content = JSON.stringify(raw.notebookJSON, null, 4);
			// await vscode.workspace.fs.writeFile(document.uri, new TextEncoder().encode(content));
		} else {
			let content = JSON.stringify({ cells: cells }, null, 4);
			// await vscode.workspace.fs.writeFile(document.uri, new TextEncoder().encode(content));
		}

		return true;
	}
}