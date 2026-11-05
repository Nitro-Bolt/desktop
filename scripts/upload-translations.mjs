import fs from 'node:fs';
import pathUtil from 'node:path';
import {fileURLToPath} from 'node:url';
import {transifexApi, RESOURCE, resourceId, projectId} from './transifex-common.mjs';

const root = pathUtil.resolve(pathUtil.dirname(fileURLToPath(import.meta.url)), '..');
const resources = {
  desktop: {
    name: 'NitroBolt Desktop',
    source: 'src-main/l10n/en.json'
  },
  'desktop-website': {
    name: 'NitroBolt Desktop Website',
    source: 'docs/l10n/en.json'
  }
};
const resource = resources[RESOURCE];
if (!resource) throw new Error(`Unknown translation resource: ${RESOURCE}`);
const source = JSON.parse(fs.readFileSync(pathUtil.join(root, resource.source), 'utf8'));

for (const [id, value] of Object.entries(source)) {
  if (!value || typeof value.string !== 'string' || value.string.length === 0) {
    throw new Error(`Invalid English source string: ${id}`);
  }
}

const upload = () => transifexApi.ResourceStringsAsyncUpload.upload({
  resource: {
    data: {
      id: resourceId,
      type: 'resources'
    }
  },
  content: JSON.stringify(source)
});

try {
  await upload();
} catch (error) {
  const status = error.statusCode ?? error.response?.statusCode ?? error.response?.status;
  if (status !== 404) throw error;

  console.log(`Creating Transifex resource ${RESOURCE}.`);
  await transifexApi.Resource.create({
    attributes: {
      slug: RESOURCE,
      name: resource.name
    },
    relationships: {
      i18n_format: {
        data: {
          id: 'STRUCTURED_JSON',
          type: 'i18n_formats'
        }
      },
      project: {
        data: {
          id: projectId,
          type: 'projects'
        }
      }
    }
  });
  await upload();
}

console.log(`Uploaded ${Object.keys(source).length} Desktop strings.`);
