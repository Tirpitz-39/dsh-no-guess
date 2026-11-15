// 边界样本矩阵：看 dsh-no-guess 的规则到底能抓什么、抓不到什么。
// 「酒吧点蛋炒饭」测试形式 = 构造不合理/矛盾/离谱但字面完整的需求。
//
//   node test/edge-cases.mjs
import { looksVague, isAck } from '../index.js'

const samples = [
  ['各个模式有什么区别', '指代不明'],
  ['那个怎么办', '指代不明'],
  ['各模式', '简写指代'],
  ['这个呢', '指代不明'],
  ['酒吧点蛋炒饭是什么意思', '带疑问'],
  ['为什么不行', '短疑问'],
  ['我要去酒吧点蛋炒饭', '矛盾需求（酒吧没厨房）'],
  ['在酒吧给我炒个蛋炒饭，灶台在储藏室', '矛盾'],
  ['帮我做蛋炒饭：不放油、不开火、不用锅', '限制自相矛盾'],
  ['把这杯酒做成蛋炒饭', '荒谬'],
  ['帮我把酒吧改成蛋炒饭店', '离谱但有动词'],
  ['把 E 盘那个项目整理成周报', '清晰任务'],
  ['继续', '回执'],
  ['好的', '回执'],
  ['1', '回执'],
  ['帮我改一下 config.json', '有动词'],
  ['你好鱼', '问候'],
  ['这个配置文件是干什么用的', '疑问+指代+无动词'],
  ['你确定没有问题？', '质疑句（不拦）'],
  ['有问题吗', '确认句（不拦）'],
]

let caught = 0
for (const [text, kind] of samples) {
  const hit = looksVague(text)
  if (hit) caught += 1
  console.log((hit ? '拦  ' : '放  ') + text + '   [' + kind + ']')
}
console.log('---')
console.log('caught=' + caught + ' total=' + samples.length)
console.log('ack(继续)=' + isAck('继续') + ' ack(好的)=' + isAck('好的'))
