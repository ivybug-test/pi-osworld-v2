import { Type, type Tool } from "@earendil-works/pi-ai";

/**
 * State-first tools for the main agent. Schemas are sent to the model; actual
 * execution is routed through the VM tool executor (OSWorld controller).
 */
export const stateTools: Tool[] = [
  {
    name: "state.bash",
    description: "Run a bash command or multi-line script inside the OSWorld VM",
    parameters: Type.Object({
      command: Type.String({ description: "Bash command or multi-line script" }),
      timeout: Type.Optional(
        Type.Number({ description: "Timeout in seconds (default 30)" }),
      ),
      working_dir: Type.Optional(
        Type.String({ description: "Working directory inside the VM" }),
      ),
    }),
  },
  {
    name: "state.python",
    description: "Run a Python script inside the OSWorld VM and read its stdout",
    parameters: Type.Object({
      code: Type.String({ description: "Python script to execute" }),
      timeout: Type.Optional(
        Type.Number({ description: "Timeout in seconds (default 90)" }),
      ),
    }),
  },
  {
    name: "state.read_file",
    description: "Read a text file from inside the OSWorld VM",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path inside the VM" }),
      timeout: Type.Optional(Type.Number()),
    }),
  },
  {
    name: "state.write_file",
    description: "Write a text file inside the OSWorld VM",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path inside the VM" }),
      content: Type.String({ description: "Full file content" }),
      timeout: Type.Optional(Type.Number()),
    }),
  },
  {
    name: "state.edit_file",
    description:
      "Replace the first occurrence of old_string with new_string inside a file in the VM",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path inside the VM" }),
      old_string: Type.String(),
      new_string: Type.String(),
      timeout: Type.Optional(Type.Number()),
    }),
  },
  {
    name: "state.view_image",
    description:
      "Read an image file from the VM and return it to the model for inspection",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path to an image inside the VM" }),
    }),
  },
  {
    name: "state.terminal",
    description: "Return the latest terminal output from the OSWorld VM",
    parameters: Type.Object({}),
  },
];
