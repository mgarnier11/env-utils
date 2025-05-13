import {
  workspace,
  languages,
  window,
  commands,
  ExtensionContext,
  Disposable,
  Position,
  Location,
  Uri,
  ReferenceContext,
  TextDocument,
  CancellationToken,
} from 'vscode';

const envVarRegex = /\${[A-Z_][A-Z0-9_]*}|\$[A-Z_][A-Z0-9_]*|\'[A-Z_][A-Z0-9_]*\'|\"[A-Z_][A-Z0-9_]*\"/;

function extractEnvVarName(envVar: string): string {
  // Remove the surrounding ${}, $, '', or "" and return the variable name
  const match = envVar.match(envVarRegex);
  if (match) {
    return match[0].replace(/^\${|^\$|^\'|^\"|\'$|\"$/g, '');
  }
  return '';
}

async function findEnvVarLocationsInEnvFiles(envVarName: string): Promise<Location[]> {
  const files = await workspace.findFiles('**/*.{env}', '**/node_modules/**');
  const locations: Location[] = [];

  for (const file of files) {
    const doc = await workspace.openTextDocument(file);
    const text = doc.getText();

    const regex = new RegExp(`^${envVarName}=(.*)$`, 'm');
    const match = text.match(regex);

    if (match) {
      // Find the line number of the match
      const index = match.index;
      const pos = doc.positionAt(index ?? 0);
      locations.push(new Location(file, pos));
    }
  }

  return locations;
}

export function activate(context: ExtensionContext) {
  console.log('Congratulations, your extension "env-utils" is now active!');
  let disposable = languages.registerDefinitionProvider(['*'], {
    async provideDefinition(document, position, token) {
      console.log('provideDefinition called 2');
      const range = document.getWordRangeAtPosition(position, envVarRegex);

      if (!range) return undefined;

      const envVar = document.getText(range);
      const envVarName = extractEnvVarName(envVar);

      const locations = await findEnvVarLocationsInEnvFiles(envVarName);

      return locations.length > 0 ? locations[0] : undefined;
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

      console.log('envVar2:', envVar);

      const envFilesLocations = await findEnvVarLocationsInEnvFiles(envVarName);

      return [...envFilesLocations];
    },
  });

  context.subscriptions.push(disposable, refDisposable);
}

// This method is called when your extension is deactivated
export function deactivate() {
  console.log('Congratulations, your extension "env-utils" is now deactivated!');
}
