import {transifexApi} from '@transifex/api';

const requireEnvironment = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
};

const ORGANIZATION = process.env.TRANSIFEX_ORGANIZATION || 'nitrobolt';
const PROJECT = process.env.TRANSIFEX_PROJECT || 'nitrobolt';
const RESOURCE = process.env.TRANSIFEX_RESOURCE || 'desktop';

transifexApi.setup({
  auth: requireEnvironment('TRANSIFEX_TOKEN')
});

const resourceId = `o:${ORGANIZATION}:p:${PROJECT}:r:${RESOURCE}`;
const projectId = `o:${ORGANIZATION}:p:${PROJECT}`;

export {transifexApi, RESOURCE, resourceId, projectId};
