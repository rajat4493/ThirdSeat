import type { Gap } from '../domain/types.ts';
import type { ResearchTool } from './types.ts';

/** Ordered registry of research tools. Future MCP-backed tools register here like any other. */
export class ToolRegistry {
  private tools: ResearchTool[] = [];

  register(tool: ResearchTool): this {
    this.tools.push(tool);
    return this;
  }

  list(): ResearchTool[] {
    return [...this.tools];
  }

  forGap(gap: Gap): ResearchTool[] {
    return this.tools.filter((t) => t.canHandle(gap));
  }
}
