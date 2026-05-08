; Direct function calls: foo(), bar(1, 2)
(call_expression
  function: (identifier) @callee.name) @call

; Method/field calls: std.debug.print(...) → MethodCall
(call_expression
  function: (field_expression
    member: (identifier) @callee.name)) @call @method.call

; Builtin calls: @This(), @sizeOf(), @import("std")
(builtin_function
  (builtin_identifier) @callee.name) @call

; @import builtins: capture module path as import edge
(builtin_function
  (arguments
    (string) @import.name)) @import
