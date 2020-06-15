/********************************************************************************
 * Copyright (C) 2018 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

/* eslint-disable no-null/no-null */

import { URI as Uri } from 'vscode-uri';
import { injectable, inject, postConstruct } from 'inversify';
import { ProtocolToMonacoConverter, MonacoToProtocolConverter, testGlob } from 'monaco-languageclient';
import URI from '@theia/core/lib/common/uri';
import { DisposableCollection } from '@theia/core/lib/common';
import { FileSystem, FileStat, } from '@theia/filesystem/lib/common';
import { FileChangeType, FileSystemWatcher } from '@theia/filesystem/lib/browser';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { EditorManager, EditorOpenerOptions } from '@theia/editor/lib/browser';
import * as lang from '@theia/languages/lib/browser';
import { Emitter, TextDocumentWillSaveEvent, TextEdit } from '@theia/languages/lib/browser';
import { MonacoTextModelService } from './monaco-text-model-service';
import { WillSaveMonacoModelEvent, MonacoEditorModel, MonacoModelContentChangedEvent } from './monaco-editor-model';
import { MonacoEditor } from './monaco-editor';
import { MonacoConfigurations } from './monaco-configurations';
import { ProblemManager } from '@theia/markers/lib/browser';
import { MaybePromise } from '@theia/core/lib/common/types';

export interface MonacoDidChangeTextDocumentParams extends lang.DidChangeTextDocumentParams {
    readonly textDocument: MonacoEditorModel;
}

export interface MonacoTextDocumentWillSaveEvent extends TextDocumentWillSaveEvent {
    readonly textDocument: MonacoEditorModel;
}

export interface CreateResourceEdit extends monaco.languages.WorkspaceFileEdit {
    readonly newUri: monaco.Uri;
}

export namespace CreateResourceEdit {
    export function is(arg: Edit): arg is CreateResourceEdit {
        return 'newUri' in arg
            && monaco.Uri.isUri(arg.newUri)
            && (!('oldUri' in arg) || !monaco.Uri.isUri(arg.oldUri));
    }
}

export interface DeleteResourceEdit extends monaco.languages.WorkspaceFileEdit {
    readonly oldUri: monaco.Uri;
}
export namespace DeleteResourceEdit {
    export function is(arg: Edit): arg is DeleteResourceEdit {
        return 'oldUri' in arg
            && monaco.Uri.isUri(arg.oldUri)
            && (!('newUri' in arg) || !monaco.Uri.isUri(arg.newUri));
    }
}

export interface RenameResourceEdit extends monaco.languages.WorkspaceFileEdit {
    readonly newUri: monaco.Uri;
    readonly oldUri: monaco.Uri;
}
export namespace RenameResourceEdit {
    export function is(arg: Edit): arg is RenameResourceEdit {
        return 'oldUri' in arg
            && monaco.Uri.isUri(arg.oldUri)
            && 'newUri' in arg
            && monaco.Uri.isUri(arg.newUri);
    }
}

export namespace WorkspaceTextEdit {
    export function is(arg: Edit): arg is monaco.languages.WorkspaceTextEdit {
        return !!arg && typeof arg === 'object'
            && 'resource' in arg
            && monaco.Uri.isUri(arg.resource)
            && 'edit' in arg
            && arg.edit !== null
            && typeof arg.edit === 'object';
    }
    export function isVersioned(arg: monaco.languages.WorkspaceTextEdit): boolean {
        return is(arg) && typeof arg.modelVersionId === 'number';
    }
}

export interface EditsByEditor extends monaco.languages.WorkspaceTextEdit {
    readonly editor: MonacoEditor;
}
export namespace EditsByEditor {
    export function is(arg: Edit): arg is EditsByEditor {
        return WorkspaceTextEdit.is(arg)
            && 'editor' in arg
            && (arg as any).editor instanceof MonacoEditor; // eslint-disable-line @typescript-eslint/no-explicit-any
    }
}

export type Edit = monaco.languages.WorkspaceFileEdit | monaco.languages.WorkspaceTextEdit;

export interface WorkspaceFoldersChangeEvent {
    readonly added: WorkspaceFolder[];
    readonly removed: WorkspaceFolder[];
}

export interface WorkspaceFolder {
    readonly uri: Uri;
    readonly name: string;
    readonly index: number;
}

@injectable()
export class MonacoWorkspace implements lang.Workspace {

    readonly capabilities = {
        applyEdit: true,
        workspaceEdit: {
            documentChanges: true
        }
    };

    protected resolveReady: () => void;
    readonly ready = new Promise<void>(resolve => {
        this.resolveReady = resolve;
    });

    protected readonly onDidOpenTextDocumentEmitter = new Emitter<MonacoEditorModel>();
    readonly onDidOpenTextDocument = this.onDidOpenTextDocumentEmitter.event;

    protected readonly onDidCloseTextDocumentEmitter = new Emitter<MonacoEditorModel>();
    readonly onDidCloseTextDocument = this.onDidCloseTextDocumentEmitter.event;

    protected readonly onDidChangeTextDocumentEmitter = new Emitter<MonacoDidChangeTextDocumentParams>();
    readonly onDidChangeTextDocument = this.onDidChangeTextDocumentEmitter.event;

    protected readonly onWillSaveTextDocumentEmitter = new Emitter<MonacoTextDocumentWillSaveEvent>();
    readonly onWillSaveTextDocument = this.onWillSaveTextDocumentEmitter.event;

    protected readonly onDidSaveTextDocumentEmitter = new Emitter<MonacoEditorModel>();
    readonly onDidSaveTextDocument = this.onDidSaveTextDocumentEmitter.event;

    protected readonly onDidChangeWorkspaceFoldersEmitter = new Emitter<WorkspaceFoldersChangeEvent>();
    readonly onDidChangeWorkspaceFolders = this.onDidChangeWorkspaceFoldersEmitter.event;

    @inject(FileSystem)
    protected readonly fileSystem: FileSystem;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(FileSystemWatcher)
    protected readonly fileSystemWatcher: FileSystemWatcher;

    @inject(MonacoTextModelService)
    protected readonly textModelService: MonacoTextModelService;

    @inject(MonacoToProtocolConverter)
    protected readonly m2p: MonacoToProtocolConverter;

    @inject(ProtocolToMonacoConverter)
    protected readonly p2m: ProtocolToMonacoConverter;

    @inject(EditorManager)
    protected readonly editorManager: EditorManager;

    @inject(MonacoConfigurations)
    readonly configurations: MonacoConfigurations;

    @inject(ProblemManager)
    protected readonly problems: ProblemManager;

    protected _workspaceFolders: WorkspaceFolder[] = [];
    get workspaceFolders(): WorkspaceFolder[] {
        return this._workspaceFolders;
    }

    @postConstruct()
    protected async init(): Promise<void> {
        const roots = await this.workspaceService.roots;
        this.updateWorkspaceFolders(roots);
        this.resolveReady();

        this.workspaceService.onWorkspaceChanged(async newRootDirs => {
            this.updateWorkspaceFolders(newRootDirs);
        });

        for (const model of this.textModelService.models) {
            this.fireDidOpen(model);
        }
        this.textModelService.onDidCreate(model => this.fireDidOpen(model));
    }

    protected updateWorkspaceFolders(newRootDirs: FileStat[]): void {
        const oldWorkspaceUris = this.workspaceFolders.map(folder => folder.uri.toString());
        const newWorkspaceUris = newRootDirs.map(folder => folder.uri);
        const added = newWorkspaceUris.filter(uri => oldWorkspaceUris.indexOf(uri) < 0).map((dir, index) => this.toWorkspaceFolder(dir, index));
        const removed = oldWorkspaceUris.filter(uri => newWorkspaceUris.indexOf(uri) < 0).map((dir, index) => this.toWorkspaceFolder(dir, index));
        this._workspaceFolders = newWorkspaceUris.map(this.toWorkspaceFolder);
        this.onDidChangeWorkspaceFoldersEmitter.fire({ added, removed });
    }

    protected toWorkspaceFolder(uriString: string, index: number): WorkspaceFolder {
        const uri = Uri.parse(uriString);
        const path = uri.path;
        return {
            uri,
            name: path.substring(path.lastIndexOf('/') + 1),
            index
        };
    }

    get rootUri(): string | null {
        if (this._workspaceFolders.length > 0) {
            return this._workspaceFolders[0].uri.toString();
        } else {
            return null;
        }
    }

    get rootPath(): string | null {
        if (this._workspaceFolders.length > 0) {
            return new URI(this._workspaceFolders[0].uri).path.toString();
        } else {
            return null;
        }
    }

    get textDocuments(): MonacoEditorModel[] {
        return this.textModelService.models;
    }

    getTextDocument(uri: string): MonacoEditorModel | undefined {
        return this.textModelService.get(uri);
    }

    protected fireDidOpen(model: MonacoEditorModel): void {
        this.doFireDidOpen(model);
        model.textEditorModel.onDidChangeLanguage(e => {
            this.problems.cleanAllMarkers(new URI(model.uri));
            model.setLanguageId(e.oldLanguage);
            try {
                this.fireDidClose(model);
            } finally {
                model.setLanguageId(undefined);
            }
            this.doFireDidOpen(model);
        });
        model.onDidChangeContent(event => this.fireDidChangeContent(event));
        model.onDidSaveModel(() => this.fireDidSave(model));
        model.onWillSaveModel(event => this.fireWillSave(event));
        model.onDirtyChanged(() => this.openEditorIfDirty(model));
        model.onDispose(() => this.fireDidClose(model));
    }

    protected doFireDidOpen(model: MonacoEditorModel): void {
        this.onDidOpenTextDocumentEmitter.fire(model);
    }

    protected fireDidClose(model: MonacoEditorModel): void {
        this.onDidCloseTextDocumentEmitter.fire(model);
    }

    protected fireDidChangeContent(event: MonacoModelContentChangedEvent): void {
        const { model, contentChanges } = event;
        this.onDidChangeTextDocumentEmitter.fire({
            textDocument: model,
            contentChanges
        });
    }

    protected fireWillSave(event: WillSaveMonacoModelEvent): void {
        const { reason } = event;
        const timeout = new Promise<TextEdit[]>(resolve =>
            setTimeout(() => resolve([]), 1000)
        );
        const resolveEdits = new Promise<TextEdit[]>(async resolve => {
            const thenables: Thenable<TextEdit[]>[] = [];
            const allEdits: TextEdit[] = [];

            this.onWillSaveTextDocumentEmitter.fire({
                textDocument: event.model,
                reason,
                waitUntil: thenable => {
                    thenables.push(thenable);
                }
            });

            for (const listenerEdits of await Promise.all(thenables)) {
                allEdits.push(...listenerEdits);
            }

            resolve(allEdits);
        });
        event.waitUntil(
            Promise.race([resolveEdits, timeout]).then(edits =>
                this.p2m.asTextEdits(edits).map(edit => edit as monaco.editor.IIdentifiedSingleEditOperation)
            )
        );
    }

    protected fireDidSave(model: MonacoEditorModel): void {
        this.onDidSaveTextDocumentEmitter.fire(model);
    }

    protected suppressedOpenIfDirty: MonacoEditorModel[] = [];

    protected openEditorIfDirty(model: MonacoEditorModel): void {
        if (this.suppressedOpenIfDirty.indexOf(model) !== -1) {
            return;
        }
        if (model.dirty && MonacoEditor.findByDocument(this.editorManager, model).length === 0) {
            // create a new reference to make sure the model is not disposed before it is
            // acquired by the editor, thus losing the changes that made it dirty.
            this.textModelService.createModelReference(model.textEditorModel.uri).then(ref => {
                this.editorManager.open(new URI(model.uri), {
                    mode: 'open',
                }).then(editor => ref.dispose());
            });
        }
    }

    protected async suppressOpenIfDirty(model: MonacoEditorModel, cb: () => MaybePromise<void>): Promise<void> {
        this.suppressedOpenIfDirty.push(model);
        try {
            await cb();
        } finally {
            const i = this.suppressedOpenIfDirty.indexOf(model);
            if (i !== -1) {
                this.suppressedOpenIfDirty.splice(i, 1);
            }
        }
    }

    createFileSystemWatcher(globPattern: string, ignoreCreateEvents?: boolean, ignoreChangeEvents?: boolean, ignoreDeleteEvents?: boolean): lang.FileSystemWatcher {
        const disposables = new DisposableCollection();
        const onDidCreateEmitter = new lang.Emitter<Uri>();
        disposables.push(onDidCreateEmitter);
        const onDidChangeEmitter = new lang.Emitter<Uri>();
        disposables.push(onDidChangeEmitter);
        const onDidDeleteEmitter = new lang.Emitter<Uri>();
        disposables.push(onDidDeleteEmitter);
        disposables.push(this.fileSystemWatcher.onFilesChanged(changes => {
            for (const change of changes) {
                const fileChangeType = change.type;
                if (ignoreCreateEvents === true && fileChangeType === FileChangeType.ADDED) {
                    continue;
                }
                if (ignoreChangeEvents === true && fileChangeType === FileChangeType.UPDATED) {
                    continue;
                }
                if (ignoreDeleteEvents === true && fileChangeType === FileChangeType.DELETED) {
                    continue;
                }
                const uri = change.uri.toString();
                const codeUri = change.uri['codeUri'];
                if (testGlob(globPattern, uri)) {
                    if (fileChangeType === FileChangeType.ADDED) {
                        onDidCreateEmitter.fire(codeUri);
                    } else if (fileChangeType === FileChangeType.UPDATED) {
                        onDidChangeEmitter.fire(codeUri);
                    } else if (fileChangeType === FileChangeType.DELETED) {
                        onDidDeleteEmitter.fire(codeUri);
                    } else {
                        throw new Error(`Unexpected file change type: ${fileChangeType}.`);
                    }
                }
            }
        }));
        return {
            onDidCreate: onDidCreateEmitter.event,
            onDidChange: onDidChangeEmitter.event,
            onDidDelete: onDidDeleteEmitter.event,
            dispose: () => disposables.dispose()
        };
    }

    /**
     * Applies given edits to the given model.
     * The model is saved if no editors is opened for it.
     */
    applyBackgroundEdit(model: MonacoEditorModel, editOperations: monaco.editor.IIdentifiedSingleEditOperation[]): Promise<void> {
        return this.suppressOpenIfDirty(model, async () => {
            const editor = MonacoEditor.findByDocument(this.editorManager, model)[0];
            const cursorState = editor && editor.getControl().getSelections() || [];
            model.textEditorModel.pushStackElement();
            model.textEditorModel.pushEditOperations(cursorState, editOperations, () => cursorState);
            model.textEditorModel.pushStackElement();
            if (!editor) {
                await model.save();
            }
        });
    }

    async applyEdit(changes: lang.WorkspaceEdit, options?: EditorOpenerOptions): Promise<boolean> {
        const workspaceEdit = this.p2m.asWorkspaceEdit(changes);
        await this.applyBulkEdit(workspaceEdit, options);
        return true;
    }

    async applyBulkEdit(workspaceEdit: monaco.languages.WorkspaceEdit, options?: EditorOpenerOptions): Promise<monaco.editor.IBulkEditResult> {
        try {
            const unresolvedEdits = this.groupEdits(workspaceEdit);
            const edits = await this.openEditors(unresolvedEdits, options);
            this.checkVersions(edits);
            let totalEdits = 0;
            let totalFiles = 0;
            for (const edit of edits) {
                if (WorkspaceTextEdit.is(edit)) {
                    const { editor } = (await this.toTextEditWithEditor(edit));
                    const model = editor.document.textEditorModel;
                    const currentSelections = editor.getControl().getSelections() || [];
                    const editOperations: monaco.editor.IIdentifiedSingleEditOperation[] = [{
                        forceMoveMarkers: false,
                        range: new monaco.Range(edit.edit.range.startLineNumber, edit.edit.range.startColumn, edit.edit.range.endLineNumber, edit.edit.range.endColumn),
                        text: edit.edit.text
                    }];
                    // start a fresh operation
                    model.pushStackElement();
                    model.pushEditOperations(currentSelections, editOperations, (_: monaco.editor.IIdentifiedSingleEditOperation[]) => currentSelections);
                    // push again to make this change an undoable operation
                    model.pushStackElement();
                    totalFiles += 1;
                    totalEdits += editOperations.length;
                } else if (CreateResourceEdit.is(edit) || DeleteResourceEdit.is(edit) || RenameResourceEdit.is(edit)) {
                    await this.performResourceEdit(edit);
                } else {
                    throw new Error(`Unexpected edit type: ${JSON.stringify(edit)}`);
                }
            }
            const ariaSummary = this.getAriaSummary(totalEdits, totalFiles);
            return { ariaSummary };
        } catch (e) {
            const ariaSummary = `Error applying workspace edits: ${e.toString()}`;
            console.error(ariaSummary);
            return { ariaSummary };
        }
    }

    protected async openEditors(edits: Edit[], options?: EditorOpenerOptions): Promise<Edit[]> {
        const result = [];
        for (const edit of edits) {
            if (WorkspaceTextEdit.is(edit) && WorkspaceTextEdit.isVersioned(edit) && !EditsByEditor.is(edit)) {
                result.push(await this.toTextEditWithEditor(edit, options));
            } else {
                result.push(edit);
            }
        }
        return result;
    }

    protected async toTextEditWithEditor(textEdit: monaco.languages.WorkspaceTextEdit, options?: EditorOpenerOptions): Promise<EditsByEditor> {
        if (EditsByEditor.is(textEdit)) {
            return textEdit;
        }
        const editorWidget = await this.editorManager.open(new URI(textEdit.resource), options);
        const editor = MonacoEditor.get(editorWidget);
        if (!editor) {
            throw Error(`Could not open editor. URI: ${textEdit.resource}`);
        }
        const textEditWithEditor = { ...textEdit, editor };
        return textEditWithEditor;
    }

    protected checkVersions(edits: Edit[]): void {
        for (const textEdit of edits.filter(WorkspaceTextEdit.is).filter(WorkspaceTextEdit.isVersioned)) {
            if (!EditsByEditor.is(textEdit)) {
                throw Error(`Could not open editor for URI: ${textEdit.resource}.`);
            }
            const model = textEdit.editor.document.textEditorModel;
            if (textEdit.modelVersionId !== undefined && model.getVersionId() !== textEdit.modelVersionId) {
                throw Error(`Version conflict in editor. URI: ${textEdit.resource}`);
            }
        }
    }

    protected getAriaSummary(totalEdits: number, totalFiles: number): string {
        if (totalEdits === 0) {
            return 'Made no edits';
        }
        if (totalEdits > 1 && totalFiles > 1) {
            return `Made ${totalEdits} text edits in ${totalFiles} files`;
        }
        return `Made ${totalEdits} text edits in one file`;
    }

    protected groupEdits(workspaceEdit: monaco.languages.WorkspaceEdit): Edit[] {
        const map = new Map<monaco.Uri, monaco.languages.WorkspaceTextEdit>();
        const result = [];
        for (const edit of workspaceEdit.edits) {
            if (WorkspaceTextEdit.is(edit)) {
                const resourceTextEdit = edit;
                const uri = resourceTextEdit.resource;
                const version = resourceTextEdit.modelVersionId;
                let editorEdit = map.get(uri);
                if (!editorEdit) {
                    editorEdit = {
                        resource: uri,
                        modelVersionId: version,
                        edit: resourceTextEdit.edit
                    };
                    map.set(uri, editorEdit);
                    result.push(editorEdit);
                } else {
                    if (editorEdit.modelVersionId !== version) {
                        throw Error(`Multiple versions for the same URI '${uri}' within the same workspace edit.`);
                    }
                }
            } else {
                const { options } = edit;
                const oldUri = !!edit.oldUri ? edit.oldUri : undefined;
                const newUri = !!edit.newUri ? edit.newUri : undefined;
                result.push({
                    oldUri,
                    newUri,
                    options
                });
            }
        }
        return result;
    }

    protected async performResourceEdit(edit: CreateResourceEdit | RenameResourceEdit | DeleteResourceEdit): Promise<void> {
        const options = edit.options || {};
        if (RenameResourceEdit.is(edit)) {
            // rename
            if (options.overwrite === undefined && options.ignoreIfExists && await this.fileSystem.exists(edit.newUri.toString())) {
                return; // not overwriting, but ignoring, and the target file exists
            }
            await this.fileSystem.move(edit.oldUri.toString(), edit.newUri.toString(), { overwrite: options.overwrite });
        } else if (DeleteResourceEdit.is(edit)) {
            // delete file
            if (!options.ignoreIfNotExists || await this.fileSystem.exists(edit.oldUri.toString())) {
                if (options.recursive === false) {
                    console.warn("Ignored 'recursive': 'false' option. Deleting recursively.");
                }
                await this.fileSystem.delete(edit.oldUri.toString());
            }
        } else if (CreateResourceEdit.is(edit)) {
            const exists = await this.fileSystem.exists(edit.newUri.toString());
            // create file
            if (options.overwrite === undefined && options.ignoreIfExists && exists) {
                return; // not overwriting, but ignoring, and the target file exists
            }
            if (exists && options.overwrite) {
                const stat = await this.fileSystem.getFileStat(edit.newUri.toString());
                if (!stat) {
                    throw new Error(`Cannot get file stat for the resource: ${edit.newUri}.`);
                }
                await this.fileSystem.setContent(stat, '');
            } else {
                await this.fileSystem.createFile(edit.newUri.toString());
            }
        }
    }
}
