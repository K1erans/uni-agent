// jsdom's ElementInternals lacks the form-associated API that @vscode-elements form controls call.
const internals = ElementInternals.prototype as Partial<ElementInternals>;
internals.setFormValue ??= () => {};
internals.setValidity ??= () => {};
