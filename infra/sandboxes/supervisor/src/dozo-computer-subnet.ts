import { getLogger } from "@rakazo/logging";
import type Docker from "dockerode";
import { COMPUTER_MEMORY_BUDGET_FULL } from "./dozo-memory-budget.js";

const RANGE_ENV = "RAKAZO_COMPUTER_NETWORK_RANGE";
/** One network: gateway, the computer and its screen peers fit in 14 addresses. */
const SUBNET_PREFIX = 28;
const SUBNET_SIZE = 2 ** (32 - SUBNET_PREFIX);
/** How many subnets Docker may refuse as overlapping before the start fails with Docker's error. */
const OVERLAP_TRIES = 8;

/** A run of IPv4 addresses as numbers, both ends included. */
type Block = { start: number; end: number };

type Networks = Pick<Docker, "listNetworks" | "createNetwork">;

/** What the picker reads of a listed network. */
type ListedNetwork = { Name?: string; IPAM?: { Config?: Array<{ Subnet?: string }> } };

function parseBlock(cidr: string): (Block & { aligned: boolean; prefix: number }) | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!match) return undefined;
  const [a, b, c, d, prefix] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (a > 255 || b > 255 || c > 255 || d > 255 || prefix > 32) return undefined;
  const address = a * 2 ** 24 + b * 2 ** 16 + c * 2 ** 8 + d;
  const size = 2 ** (32 - prefix);
  const start = address - (address % size);
  return { start, end: start + size - 1, aligned: start === address, prefix };
}

function formatAddress(address: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(address / 2 ** shift) % 256).join(".");
}

function formatSubnet(start: number): string {
  return `${formatAddress(start)}/${SUBNET_PREFIX}`;
}

/**
 * The range computer networks are cut from. Undefined when the operator set none: networks then
 * take a subnet from the daemon's default pools, as upstream does. A malformed value throws,
 * naming the variable. Read on every call so a test and a restart behave the same.
 */
export function computerNetworkRange(raw = process.env[RANGE_ENV]): Block | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const block = parseBlock(raw);
  if (!block?.aligned || block.prefix > SUBNET_PREFIX) {
    throw new Error(
      `${RANGE_ENV} must be an IPv4 range of /${SUBNET_PREFIX} or wider with no host bits set, such as 10.214.0.0/16 (got "${raw}")`,
    );
  }
  return { start: block.start, end: block.end };
}

/** The IPv4 blocks the listed networks hold, leaving out the network named `exceptName`. */
export function usedBlocks(networks: ListedNetwork[], exceptName?: string): Block[] {
  return networks
    .filter((network) => network.Name !== exceptName)
    .flatMap((network) => network.IPAM?.Config ?? [])
    .flatMap((entry) => parseBlock(entry.Subnet ?? "") ?? []);
}

/** The first /28 of the range that touches none of the used blocks, or undefined when none is left. */
export function freeSubnet(range: Block, used: Block[]): string | undefined {
  for (let start = range.start; start + SUBNET_SIZE - 1 <= range.end; start += SUBNET_SIZE) {
    const end = start + SUBNET_SIZE - 1;
    if (!used.some((block) => block.start <= end && start <= block.end)) return formatSubnet(start);
  }
  return undefined;
}

/**
 * The same network with its IPv4 subnet and gateway named. The gateway is the subnet's first host
 * address, the one Docker would pick; it is named because Docker 28 leaves it out of the network's
 * inspect when only the subnet was given, and the egress probe reads it from there. IPv6 stays
 * automatic: with `EnableIPv6` and no IPv6 entry, Docker 27+ still allocates its own ULA /64.
 */
export function withSubnet<T extends object>(options: T, subnet: string) {
  const block = parseBlock(subnet);
  if (!block) throw new Error(`not an IPv4 subnet: ${subnet}`);
  const Gateway = formatAddress(block.start + 1);
  return { ...options, IPAM: { Driver: "default", Config: [{ Subnet: subnet, Gateway }] } };
}

// ponytail: one lock in this process, with no wait limit. It holds while this supervisor is the
// only one cutting this range on its Docker host; a second one would meet Docker's overlap refusal
// and take the next subnet. A Docker call that never answers holds later creations with it.
let tail: Promise<void> = Promise.resolve();

async function createInRange(
  docker: Networks,
  create: Docker["createNetwork"],
  options: Docker.NetworkCreateOptions,
  range: Block,
) {
  // The network's own block counts as free: when it already exists Docker answers "already
  // exists", which the callers expect, even with every other subnet taken.
  const used = usedBlocks(await docker.listNetworks(), options.Name);
  let refusal: unknown;
  for (let attempt = 0; attempt < OVERLAP_TRIES; attempt++) {
    const subnet = freeSubnet(range, used);
    if (!subnet) {
      getLogger().warn("computer network range is full", { variable: RANGE_ENV });
      // The start is refused as "all computers are busy" (429), not as a fault.
      throw new Error(COMPUTER_MEMORY_BUDGET_FULL);
    }
    try {
      return await create(withSubnet(options, subnet));
    } catch (error) {
      // Something outside this process took the subnet between the list and the create.
      if (!/overlap/i.test(String(error))) throw error;
      refusal = error;
      const taken = parseBlock(subnet);
      if (taken) used.push(taken);
    }
  }
  throw refusal;
}

/**
 * Makes every network this Docker client creates take a /28 of the operator's range instead of a
 * slot of the daemon's default address pools, which a shared host runs out of. Creations go one at
 * a time, so two never pick the same subnet. With no range set the client is returned untouched.
 * A malformed range throws here, at supervisor start.
 */
export function withComputerSubnets<T extends Networks>(docker: T): T {
  if (!computerNetworkRange()) return docker;
  const create = docker.createNetwork.bind(docker) as Docker["createNetwork"];
  docker.createNetwork = ((options: Docker.NetworkCreateOptions) => {
    const range = computerNetworkRange();
    if (!range) return create(options);
    const created = tail.then(() => createInRange(docker, create, options, range));
    tail = created.then(
      () => undefined,
      () => undefined,
    );
    return created;
  }) as Docker["createNetwork"];
  return docker;
}
