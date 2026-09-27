import { create } from 'zustand'
import type { Furniture, FurnitureName } from '../types/furniture'
import type { JointName, JointType } from '../types/jointType'
import type { Member } from '../types/member'
import { db, ensureSeedData } from '../utils/db'

export type JointDraft = Omit<JointType, 'id' | 'schemaRev'>
export type FurnitureDraft = Omit<Furniture, 'id' | 'schemaRev'>

interface JointState {
  joints: JointType[]
  members: Member[]
  furniture: Furniture[]
  stepCounts: Record<string, number>
  selectedJointId: string | null
  loading: boolean
  loadAll: () => Promise<void>
  addJoint: (draft: JointDraft) => Promise<JointType>
  duplicateJoint: (sourceId: string, name: JointName) => Promise<JointType>
  addFurniture: (draft: FurnitureDraft) => Promise<Furniture>
  setSelectedJoint: (id: string) => void
  updateMemberDimensions: (
    memberId: string,
    dimensions: Pick<Member, 'lengthMm' | 'widthMm' | 'thicknessMm' | 'toleranceMm'>,
  ) => Promise<void>
  renameMember: (memberId: string, name: Member['name']) => Promise<void>
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

// SVG 里的构件引用都以引号包裹（data-member-id="..."），按带引号的整体替换，
// 避免新旧 id 互为前缀时误替换，保证副本热区指向副本自己的构件。
function remapMemberReferences(svgMarkup: string, memberIds: Map<string, string>): string {
  let remapped = svgMarkup
  for (const [sourceId, copyId] of memberIds) {
    remapped = remapped.split(`"${sourceId}"`).join(`"${copyId}"`)
  }
  return remapped
}

export const useJointStore = create<JointState>((set, get) => ({
  joints: [],
  members: [],
  furniture: [],
  stepCounts: {},
  selectedJointId: null,
  loading: false,

  loadAll: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      await ensureSeedData()
      const [joints, members, furniture, steps] = await Promise.all([
        db.joints.toArray(),
        db.members.toArray(),
        db.furniture.toArray(),
        db.steps.toArray(),
      ])
      const stepCounts = steps.reduce<Record<string, number>>((counts, step) => {
        counts[step.jointTypeId] = (counts[step.jointTypeId] ?? 0) + 1
        return counts
      }, {})
      const selectedJointId = get().selectedJointId
      set({
        joints: joints.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
        members,
        furniture,
        stepCounts,
        selectedJointId: selectedJointId && joints.some((joint) => joint.id === selectedJointId)
          ? selectedJointId
          : joints[0]?.id ?? null,
      })
    } finally {
      set({ loading: false })
    }
  },

  addJoint: async (draft) => {
    const joint: JointType = { ...draft, id: createId('joint'), schemaRev: 2 }
    await db.joints.add(joint)
    set((state) => ({
      joints: [...state.joints, joint].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
      selectedJointId: joint.id,
      stepCounts: { ...state.stepCounts, [joint.id]: 0 },
    }))
    return joint
  },

  duplicateJoint: async (sourceId, name) => {
    const source = get().joints.find((joint) => joint.id === sourceId) ?? await db.joints.get(sourceId)
    if (!source) throw new Error('未找到要复制的榫卯类型')
    const [sourceMembers, sourceSteps, sourceDiagrams, sourceFurniture] = await Promise.all([
      db.members.where('jointTypeId').equals(sourceId).toArray(),
      db.steps.where('jointTypeId').equals(sourceId).toArray(),
      db.diagrams.where('jointTypeId').equals(sourceId).toArray(),
      db.furniture.where('jointTypeId').equals(sourceId).toArray(),
    ])

    const jointId = createId('joint')
    const memberIds = new Map(sourceMembers.map((member) => [member.id, createId('member')]))
    const stepIds = new Map(sourceSteps.map((step) => [step.id, createId('step')]))

    const joint: JointType = { ...source, id: jointId, name, copiedFromId: sourceId, schemaRev: 2 }
    const members: Member[] = sourceMembers.map((member) => ({
      ...member,
      id: memberIds.get(member.id) ?? createId('member'),
      jointTypeId: jointId,
    }))
    const steps = sourceSteps.map((step) => ({
      ...step,
      id: stepIds.get(step.id) ?? createId('step'),
      jointTypeId: jointId,
    }))
    const diagrams = sourceDiagrams.map((diagram) => ({
      ...diagram,
      id: createId('diagram'),
      jointTypeId: jointId,
      stepId: stepIds.get(diagram.stepId) ?? diagram.stepId,
      svgMarkup: remapMemberReferences(diagram.svgMarkup, memberIds),
      hitAreas: diagram.hitAreas.map((area) => ({
        ...area,
        id: createId('hit'),
        memberId: memberIds.get(area.memberId) ?? area.memberId,
      })),
    }))
    const furniture: Furniture[] = sourceFurniture.map((item) => ({
      ...item,
      id: createId('furniture'),
      jointTypeId: jointId,
    }))

    await db.transaction('rw', [db.joints, db.members, db.steps, db.diagrams, db.furniture], async () => {
      await db.joints.add(joint)
      await db.members.bulkAdd(members)
      await db.steps.bulkAdd(steps)
      await db.diagrams.bulkAdd(diagrams)
      await db.furniture.bulkAdd(furniture)
    })

    set((state) => ({
      joints: [...state.joints, joint].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
      members: [...state.members, ...members],
      furniture: [...state.furniture, ...furniture],
      stepCounts: { ...state.stepCounts, [jointId]: steps.length },
      selectedJointId: jointId,
    }))
    return joint
  },

  addFurniture: async (draft) => {
    const furniture: Furniture = { ...draft, id: createId('furniture'), schemaRev: 2 }
    await db.furniture.add(furniture)
    set((state) => ({ furniture: [...state.furniture, furniture] }))
    return furniture
  },

  setSelectedJoint: (id) => set({ selectedJointId: id }),

  updateMemberDimensions: async (memberId, dimensions) => {
    await db.members.update(memberId, dimensions)
    set((state) => ({
      members: state.members.map((member) => (
        member.id === memberId ? { ...member, ...dimensions } : member
      )),
    }))
  },

  renameMember: async (memberId, name) => {
    await db.members.update(memberId, { name })
    set((state) => ({
      members: state.members.map((member) => (
        member.id === memberId ? { ...member, name } : member
      )),
    }))
  },
}))

export type { FurnitureName }
