import path from 'node:path';
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
  RelativePattern,
} from 'vscode';

interface EnvVarData {
  location: Location;
  value: string;
  name: string;
}

const envVarRegex = /\${[A-Z_][A-Z0-9_]*}|\$[A-Z_][A-Z0-9_]*|\'[A-Z_][A-Z0-9_]*\'|\"[A-Z_][A-Z0-9_]*\"/g;

let envVarCache: Map<string, EnvVarData[]> = new Map();

async function rebuildEnvVarCache() {
  console.time('rebuildEnvVarCache');

  const config = workspace.getConfiguration('envUtils');
  const ignoreFolders: string[] = config.get('ignoreFolders') || ['**/node_modules/**'];
  const ignoreWorkspaceFolders: string[] = config.get('ignoreWorkspaceFolders') || ['docker-data'];

  envVarCache.clear();
  const workspaceFolders =
    workspace.workspaceFolders?.filter((folder) => !ignoreWorkspaceFolders.includes(folder.name)) || [];

  for (const folder of workspaceFolders) {
    console.time(`Searching in workspace folder: ${folder.name}`);
    const envFileGlob = new RelativePattern(folder, '**/*.env');
    const envFiles = await workspace.findFiles(envFileGlob, `{${ignoreFolders.join(',')}}`);
    console.timeEnd(`Searching in workspace folder: ${folder.name}`);

    console.log(`Found ${envFiles.length} env files in workspace folder ${folder.name}`);

    await Promise.all(
      envFiles.map(async (file) => {
        console.log(`Processing file: ${file.fsPath}`);
        const doc = await workspace.openTextDocument(file);
        const text = doc.getText();
        const lines = text.split('\n');

        for (const line of lines) {
          const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
          if (match) {
            const [_, name, value] = match;
            const pos = new Position(lines.indexOf(line), 0);
            const data: EnvVarData = {
              location: new Location(file, pos),
              value: value.trim(),
              name,
            };
            if (!envVarCache.has(name)) envVarCache.set(name, []);
            envVarCache.get(name)!.push(data);
          }
        }
      })
    );
  }

  console.log(`Env var cache rebuilt with ${envVarCache.size} entries`);
  console.timeEnd('rebuildEnvVarCache');
}

function extractEnvVarName(envVar: string): string {
  // Remove ${...}, $..., '...', or "..."
  let name = envVar.trim();
  // Remove ${...}
  if (name.startsWith('${') && name.endsWith('}')) {
    name = name.slice(2, -1);
  }
  // Remove quotes
  if ((name.startsWith("'") && name.endsWith("'")) || (name.startsWith('"') && name.endsWith('"'))) {
    name = name.slice(1, -1);
  }
  // Remove leading $
  if (name.startsWith('$')) {
    name = name.slice(1);
  }
  return name;
}

async function findEnvVarDatas(envVarName: string, baseUri?: Uri): Promise<EnvVarData[]> {
  const envVarDatas = envVarCache.get(envVarName) || [];
  if (!baseUri || envVarDatas.length <= 1) return envVarDatas;

  const baseDir = path.dirname(baseUri.fsPath);

  // Compute a "distance" score for each env var location
  const scored = envVarDatas.map((data) => {
    const varDir = path.dirname(data.location.uri.fsPath);
    const rel = path.relative(baseDir, varDir);
    // Split the relative path and count segments (ignoring '.' for same dir)
    const segments = rel === '' ? [] : rel.split(path.sep);
    // Score: number of segments, with '..' (parent) segments weighted higher
    let score = 0;
    for (const seg of segments) {
      if (seg === '..') score += 2; // parent dirs are "further"
      else score += 1; // subdirs are "closer" than parent dirs
    }
    return { data, score };
  });

  scored.sort((a, b) => a.score - b.score);

  return scored.map((s) => s.data);
}

const decorationType = window.createTextEditorDecorationType({
  after: {
    color: '#888',
    margin: '-20 0 0 1em',
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
    const sanitizedValue = value.replace(/^[\'\"]|[\'\"]$/g, '');
    const start = editor.document.positionAt(match.index ?? 0);
    const end = editor.document.positionAt((match.index ?? 0) + envVar.length);
    decorations.push({
      range: new Range(start, end),
      renderOptions: {
        after: {
          contentText: `${sanitizedValue}`,
        },
      },
    });
  }
  editor.setDecorations(decorationType, decorations);
}

export function activate(context: ExtensionContext) {
  console.log('Congratulations, your extension "env-utils" is now active!');
  rebuildEnvVarCache();

  let disposable = languages.registerDefinitionProvider(['*'], {
    async provideDefinition(document, position, token) {
      console.log('provideDefinition called');
      const range = document.getWordRangeAtPosition(position, envVarRegex);

      if (!range) return undefined;

      const envVar = document.getText(range);
      const envVarName = extractEnvVarName(envVar);

      console.log(`envVarName: ${envVarName}`);

      const envVarDatas = await findEnvVarDatas(envVarName, document.uri);

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
