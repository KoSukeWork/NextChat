// Lifecycle controls are declared in the manifest. Request generation stays in
// the independent adapter; desktop management does not change wire behavior.
export {
  prepareChat,
  prepareRequest,
} from "../claude-code-switchable/index.mjs";
