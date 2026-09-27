import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useJointStore } from '../../stores/jointStore'
import type { JointType } from '../../types/jointType'
import { db } from '../../utils/db'

interface CopyJointPanelProps {
  source: JointType
  onClose: () => void
}

export function CopyJointPanel({ source, onClose }: CopyJointPanelProps) {
  const navigate = useNavigate()
  const members = useJointStore((state) => state.members)
  const furniture = useJointStore((state) => state.furniture)
  const stepCounts = useJointStore((state) => state.stepCounts)
  const duplicateJoint = useJointStore((state) => state.duplicateJoint)
  const [name, setName] = useState(`${source.name} 副本`)
  const [diagramCount, setDiagramCount] = useState(0)
  const [submitting, setSubmitting] = useState(false)

  const memberCount = members.filter((member) => member.jointTypeId === source.id).length
  const furnitureCount = furniture.filter((item) => item.jointTypeId === source.id).length
  const stepCount = stepCounts[source.id] ?? 0

  useEffect(() => {
    setName(`${source.name} 副本`)
    setSubmitting(false)
    let cancelled = false
    void db.diagrams.where('jointTypeId').equals(source.id).count().then((count) => {
      if (!cancelled) setDiagramCount(count)
    })
    return () => {
      cancelled = true
    }
  }, [source.id, source.name])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!name.trim() || submitting) return
    setSubmitting(true)
    const created = await duplicateJoint(source.id, name)
    if (created) {
      onClose()
      navigate(`/joints/${created.id}`)
    } else {
      setSubmitting(false)
    }
  }

  return (
    <form className="panel grid gap-5 p-5 sm:p-6" data-testid="form-copy-joint" onSubmit={(event) => void submit(event)}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-wood-900">复制「{source.name}」</h2>
          <p className="mt-1 text-xs leading-5 text-stone-500">
            将一并复制 {memberCount} 件构件、{stepCount} 步拆装、{diagramCount} 张示意图与 {furnitureCount} 条家具关联，
            步骤编号与热区绑定关系保持不变，改动副本不影响原类型。
          </p>
        </div>
        <button type="button" className="rounded-lg px-3 py-2 text-sm text-stone-500 hover:bg-stone-100" onClick={onClose}>收起</button>
      </div>
      <label className="space-y-1.5 text-sm">
        <span className="font-medium text-stone-700">新类型名称</span>
        <input
          required
          autoFocus
          className="input-field"
          data-testid="field-copy-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如：燕尾榫 副本"
        />
      </label>
      <div className="flex justify-end gap-3">
        <button type="button" className="secondary-button" onClick={onClose}>取消</button>
        <button type="submit" className="primary-button" data-testid="submit-copy-joint" disabled={submitting || !name.trim()}>
          {submitting ? '正在复制…' : '确认复制'}
        </button>
      </div>
    </form>
  )
}
