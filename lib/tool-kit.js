/**
 * 最小的工具构造器。
 *
 * 这个包刻意**零运行时依赖**——不 import 任何 `@deepseek-ai/*` 包。原因是包的位置
 * 在用户目录下，Node 的 `node_modules` 向上查找到不了 harness 自己的依赖，而
 * `@deepseek-ai/dsh-tools` 的传递依赖（cordis / dsh-llm / dsh-scope / dsh-brand …）
 * 会形成 vendor 雪球。所以注册表要求的定义对象在这里直接构造。
 *
 * 换来的一件额外好处：参数校验是自己写的，错误信息能说清是哪个参数、该给什么值，
 * 比通用 schema 走查的诊断更省作者的时间。
 *
 * 两个入口（`lib/index.js` 与 `lib/doctor.js`）共用这里的工厂，因此
 * `story_doctor` 在写作模式里和独立挂载时是同一个实现，不会漂移。
 *
 * @module dsh-story-mode/tool-kit
 */

/**
 * 把简写参数表编译成注册表要求的对象根 JSON Schema。
 *
 * 支持的子集与注册表的走查一致：type / properties / required / enum / description。
 * 无参数工具（`story_doctor`）不声明 `required`——空数组是合法 JSON Schema，
 * 但省掉它读起来更干净。
 */
export function compileParameters(spec) {
  const properties = {}
  const required = []
  for (const [key, field] of Object.entries(spec)) {
    properties[key] = {
      type: field.type,
      ...field.enum === undefined ? {} : { enum: [...field.enum] },
      ...field.description === undefined ? {} : { description: field.description },
    }
    if (field.required === true) required.push(key)
  }
  return { type: 'object', properties, ...required.length === 0 ? {} : { required } }
}

/** 校验一次调用。返回违规说明数组，空数组表示通过。 */
export function validateArgs(spec, args) {
  const violations = []
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return ['arguments 必须是一个对象']
  }
  for (const [key, field] of Object.entries(spec)) {
    const value = args[key]
    if (value === undefined || value === null) {
      if (field.required === true) violations.push(`缺少必填参数 ${key}`)
      continue
    }
    if (field.type === 'string' && typeof value !== 'string') {
      violations.push(`${key} 必须是字符串`)
      continue
    }
    if (field.type === 'number' && !(typeof value === 'number' && Number.isFinite(value))) {
      violations.push(`${key} 必须是数字`)
      continue
    }
    if (field.enum !== undefined && !field.enum.includes(value)) {
      violations.push(`${key} 只能是 ${field.enum.join(' / ')} 之一，收到 ${JSON.stringify(value)}`)
    }
  }
  return violations
}

/**
 * 构造一个注册表就绪的工具定义。
 *
 * 输出固定是 `{ text }`：模型读到的内容与渲染出来的内容一致——报告里的每个
 * 数字都来自同一次计算，不需要为了展示再算一遍。
 *
 * `required` 的写法有一处硬性约束：它是**对象节点上的字符串数组**，不是属性
 * 里的布尔值。宿主对 schema 做的是白名单走查（`type` / `oneOf` / `properties` /
 * `required` / `additionalProperties` / `items` / `enum` / `const`），而
 * `required` 属于对象关键字，摆在标量节点上会被判成
 * `...properties.text.required is not supported on type "string"`——这不会降级成
 * 一次调用失败，而是让 `apply` 抛出、整份 preset 变成 broken 行，表现为
 * "模式切不过去"。所以这里必须先声明 `properties`，再在同级用一个数组列名字。
 */
export function makeTool({ name, description, parameters, presentCall, run }) {
  return {
    name,
    description,
    parameters: compileParameters(parameters),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const violations = validateArgs(parameters, args)
      if (violations.length > 0) {
        const error = new Error(`${name}: invalid arguments: ${violations.join('; ')}`)
        error.name = 'ToolArgsError'
        error.violations = violations
        throw error
      }
      return { text: await run(args, exec) }
    },
    ...presentCall === undefined ? {} : { presentCall },
  }
}
