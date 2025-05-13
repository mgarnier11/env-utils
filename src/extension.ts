import {
  workspace,
  languages,
  window,
  MarkdownString,
  ExtensionContext,
  Hover,
  Position,
  Location,
  Uri,
  TextEditor,
  ReferenceContext,
  TextDocument,
  CancellationToken,
  DecorationOptions,
  Range,
} from 'vscode';

interface EnvVarData {
  location: Location;
  value: string;
  name: string;
}

const envVarRegex = /\${[A-Z_][A-Z0-9_]*}|\$[A-Z_][A-Z0-9_]*|\'[A-Z_][A-Z0-9_]*\'|\"[A-Z_][A-Z0-9_]*\"/g;

function extractEnvVarName(envVar: string): string {
  // Remove the surrounding ${}, $, '', or "" and return the variable name
  const match = envVar.match(envVarRegex);
  if (match) {
    return match[0].replace(/^\${|^\$|^\'|^\"|\'$|\"$/g, '');
  }
  return '';
}

async function findEnvVarDatas(envVarName: string): Promise<EnvVarData[]> {
  const files = await workspace.findFiles('**/*.{env}', '**/node_modules/**');
  const locations: EnvVarData[] = [];

  for (const file of files) {
    const doc = await workspace.openTextDocument(file);
    const text = doc.getText();

    const regex = new RegExp(`^${envVarName}=(.*)$`, 'm');
    const match = text.match(regex);

    if (match) {
      // Find the line number of the match
      const index = match.index;
      const pos = doc.positionAt(index ?? 0);
      const value = match[1].trim();
      locations.push({
        location: new Location(file, pos),
        value,
        name: envVarName,
      });
    }
  }

  return locations;
}

const decorationType = window.createTextEditorDecorationType({
  after: {
    color: '#888',
    margin: '0 0 0 1em',
  },
});

async function updateDecorations(editor: TextEditor | undefined) {
  if (!editor) return;
  const text = editor.document.getText();
  const decorations: DecorationOptions[] = [];

  for (const match of text.matchAll(envVarRegex)) {
    const envVar = match[0];
    const envVarName = extractEnvVarName(envVar);
    const envVarDatas = await findEnvVarDatas(envVarName);
    if (envVarDatas.length === 0) continue;
    const value = envVarDatas[0].value;
    const start = editor.document.positionAt(match.index ?? 0);
    const end = editor.document.positionAt((match.index ?? 0) + envVar.length);
    decorations.push({
      range: new Range(start, end),
      renderOptions: {
        after: {
          contentText: `${value}`,
        },
      },
    });
  }
  editor.setDecorations(decorationType, decorations);
}

export function activate(context: ExtensionContext) {
  console.log('Congratulations, your extension "env-utils" is now active!');
  let disposable = languages.registerDefinitionProvider(['*'], {
    async provideDefinition(document, position, token) {
      console.log('provideDefinition called');
      const range = document.getWordRangeAtPosition(position, envVarRegex);

      if (!range) return undefined;

      const envVar = document.getText(range);
      const envVarName = extractEnvVarName(envVar);

      console.log(`envVarName: ${envVarName}`);

      const envVarDatas = await findEnvVarDatas(envVarName);

      return envVarDatas.length > 0 ? envVarDatas[0].location : undefined;
    },
  });

  // Register ReferenceProvider
  let refDisposable = languages.registerReferenceProvider(['*'], {
    async provideReferences(
      document: TextDocument,
      position: Position,
      context: ReferenceContext,
      token: CancellationToken
    ) {
      const range = document.getWordRangeAtPosition(position, envVarRegex);
      if (!range) return [];
      const envVar = document.getText(range);
      const envVarName = extractEnvVarName(envVar);

      const envVarDatas = await findEnvVarDatas(envVarName);

      return [...envVarDatas.map((data) => data.location)];
    },
  });

  // Register HoverProvider
  let hoverDisposable = languages.registerHoverProvider(['*'], {
    async provideHover(document, position, token) {
      const range = document.getWordRangeAtPosition(position, envVarRegex);
      if (!range) return;
      const envVar = document.getText(range);
      const envVarName = extractEnvVarName(envVar);

      const envVarDatas = await findEnvVarDatas(envVarName);

      if (envVarDatas.length === 0) return;

      const envVarData = envVarDatas[0];
      return new Hover(new MarkdownString(`**Value:** \`${envVarData.value}\``), range);
    },
  });

  // Update decorations on editor change or document change
  window.onDidChangeActiveTextEditor((editor) => updateDecorations(editor), null, context.subscriptions);
  workspace.onDidChangeTextDocument(
    (event) => {
      if (window.activeTextEditor && event.document === window.activeTextEditor.document) {
        updateDecorations(window.activeTextEditor);
      }
    },
    null,
    context.subscriptions
  );

  // Update decorations for the active editor on extension activation
  updateDecorations(window.activeTextEditor);

  context.subscriptions.push(disposable, refDisposable, hoverDisposable, decorationType);
}

// This method is called when your extension is deactivated
export function deactivate() {
  console.log('Congratulations, your extension "env-utils" is now deactivated!');
}
