// Where the game's original files come from.
//   'local'      - load them from LOCAL_GAME_FILES_PATH (orgfiles/ in the project root), served by
//                  tools/serve.mjs to this computer only. For playing and developing on your PC.
//   'production' - players open their own Zoo Tycoon 2 files (.z2f); nothing is downloaded.
// Set this to 'production' for any public deployment, and never deploy the orgfiles/ folder.
export const GAME_FILES_MODE = 'local';

export const LOCAL_GAME_FILES_PATH = 'orgfiles/';
