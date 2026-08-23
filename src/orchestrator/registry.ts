import type { Agent } from '../agents/agent';
import { analyst } from '../agents/analyst';
import { creative } from '../agents/creative';
import { guardian } from '../agents/guardian';
import { mediabuyer } from '../agents/mediabuyer';
import { optimizer } from '../agents/optimizer';
import { producer } from '../agents/producer';
import { publisher } from '../agents/publisher';
import { quant } from '../agents/quant';
import { scout } from '../agents/scout';
import { strategist } from '../agents/strategist';
import type { AgentId } from '../types';

/** Every agent in the system. Nothing runs that is not registered here. */
export const REGISTRY: Record<AgentId, Agent> = {
  strategist,
  creative,
  producer,
  publisher,
  mediabuyer,
  optimizer,
  analyst,
  guardian,
  scout,
  quant,
};

export function agentFor(agentId: string): Agent | undefined {
  return REGISTRY[agentId as AgentId];
}

export function describeRegistry(): { agent: string; describe: string; tasks: string[] }[] {
  return Object.values(REGISTRY).map((agent) => ({
    agent: agent.id,
    describe: agent.describe,
    tasks: Object.keys(agent.tasks),
  }));
}
