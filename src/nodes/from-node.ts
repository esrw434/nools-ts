import isArray from 'lodash-ts/isArray';
import isEmpty from 'lodash-ts/isEmpty';
import mixin from 'lodash-ts/mixin';
import Context from '../context';
import { IFromPattern } from '../pattern';
import WorkingMemory from '../working-memory';
import { IConstraint, is_instance_of_hash, is_instance_of_equality, is_instance_of_reference_constraint } from '../constraint';
import Fact from '../facts/fact';
import { joinNodeType } from './node';
import { __addToLeftMemory, assert, removeFromLeftMemory, modify, retract } from './beta-node';
import { IJoinNode, _create_join_node, assert_left as base_assert_left } from './join-node';

export interface IFromNode extends IJoinNode {
	pattern: IFromPattern;
	alias: string;
	type_assert: (type: any) => boolean;
	from_assert: (fact: any, fh?: any) => any;
	constraints: IConstraint[];
	fromMemory: { [id: number]: { [hashCode: string]: [Context, Context] }; };
	__equalityConstraints: { (factHanle1: Map<string, Fact>, factHandle2: Map<string, Fact>): boolean; }[];
	__variables: any[];
	workingMemory: WorkingMemory;
}

export function _create_from_node(type: joinNodeType, pattern: IFromPattern, wm: WorkingMemory): IFromNode {
	const type_constraint = pattern.constraints[0];
	const from = pattern.from;
	const constraints = pattern.constraints.slice(1);
	let vars: any[] = [];
	const eqConstraints: { (factHanle1: Map<string, Fact>, factHandle2: Map<string, Fact>): boolean; }[] = [];
	constraints.forEach((c) => {
		if (is_instance_of_equality(c) || is_instance_of_reference_constraint(c)) {
			eqConstraints.push((factHanle1: Map<string, Fact>, factHandle2: Map<string, Fact>) => {
				return c.assert(factHanle1, factHandle2);
			});
		} else if (is_instance_of_hash(c)) {
			// todo: need debug
			debugger;
			vars = vars.concat(c.constraint);
		}
	});
	return mixin(_create_join_node(type), {
		pattern: pattern,
		alias: pattern.alias,
		constraints: constraints,
		__equalityConstraints: eqConstraints,
		__variables: vars,
		fromMemory: {},
		workingMemory: wm,
		type_assert(type: any) {
			return type_constraint.assert(type);
		},
		from_assert(fact: any, fh?: any) {
			return from.assert(fact, fh);
		}
	});
}

export function create(pattern: IFromPattern, wm: WorkingMemory): IFromNode {
	return _create_from_node('from', pattern, wm);
}

const DEFAULT_MATCH = {
	isMatch: function () {
		return false;
	}
} as Context;

function __createMatch(node: IFromNode, lc: Context, o: any) {
	if (node.type_assert(o)) {
		const createdFact = node.workingMemory.getFactHandle(o);
		const rc = new Context(createdFact, null, null)
			.set(node.alias, o);
		const createdFactId = createdFact.id;
		const fh = rc.factHash, lcFh = lc.factHash;
		for (const [key, fact] of lcFh) {
			fh.set(key, fact);
		}
		let fm = node.fromMemory[createdFactId];
		if (!fm) {
			fm = node.fromMemory[createdFactId] = {} as any;
		}
		const eqConstraints = node.__equalityConstraints;
		if (eqConstraints.some((eqConstraint) => {
			if (!eqConstraint(fh, fh)) {
				return true;
			} else {
				return false;
			}
		})) {
			const createdContext = DEFAULT_MATCH;
			fm[lc.hashCode] = [lc, createdContext];
			return createdContext;
		} else {
			node.__variables.forEach((prop) => {
				fh.set(prop, o[prop]);
			});
			const createdContext = rc.clone(createdFact, null, lc.match.merge(rc.match));
			lc.fromMatches[createdFact.id] = createdContext;
			fm[lc.hashCode] = [lc, createdContext];
			return createdContext;
		}
	}
	return DEFAULT_MATCH;
}

function __checkMatch(node: IFromNode, context: Context, o: any, propogate = false) {
	const newContext = __createMatch(node, context, o);
	if (newContext.isMatch() && propogate) {
		assert(node, newContext.clone());
	}
	return newContext;
}

function __createMatches(node: IFromNode, context: Context) {
	const fh = context.factHash, o = node.from_assert(fh);
	if (isArray(o)) {
		(o as any[]).forEach((o) => {
			__checkMatch(node, context, o, true);
		});
	} else if (o !== undefined) {
		__checkMatch(node, context, o, true);
	}
}

export function assert_left(node: IFromNode, context: Context) {
	__addToLeftMemory(node, context);
	context.fromMatches = {};
	__createMatches(node, context);
}

// export function assert_right(node: IFromNode, context: Context) {
// 	throw new Error("Shouldnt have gotten here");
// }

function removeFromFromMemory(node: IFromNode, context: Context) {
	const factId = context.fact.id;
	const fm = node.fromMemory[factId];
	if (fm) {
		for (const i in fm) {
			const entry = fm[i];
			if (entry[1] === context) {
				delete fm[i];
				if (isEmpty(fm)) {
					delete node.fromMemory[factId];
				}
				break;
			}
		}
	}

}

export function modify_left(node: IFromNode, context: Context) {
	const ctx = removeFromLeftMemory(node, context);
	// newContext, i, l, factId, fact;
	if (ctx) {
		__addToLeftMemory(node, context);
		const leftContext = ctx.data;
		context.fromMatches = {};
		const fromMatches = context.fromMatches;
		const rightMatches = leftContext.fromMatches;
		const o = node.from_assert(context.factHash);

		if (isArray(o)) {
			(o as any[]).forEach((o) => {
				const newContext = __checkMatch(node, context, o, false);
				if (newContext.isMatch()) {
					const factId = newContext.fact.id;
					if (factId in rightMatches) {
						modify(node, newContext.clone());
					} else {
						assert(node, newContext.clone());
					}
				}
			});
		} else if (o !== undefined) {
			const newContext = __checkMatch(node, context, o, false);
			if (newContext.isMatch()) {
				const factId = newContext.fact.id;
				if (factId in rightMatches) {
					modify(node, newContext.clone());
				} else {
					assert(node, newContext.clone());
				}
			}
		}
		for (const i in rightMatches) {
			if (!(i in fromMatches)) {
				removeFromFromMemory(node, rightMatches[i]);
				retract(node, rightMatches[i].clone());
			}
		}
	} else {
		base_assert_left(node, context);
	}
	const fact = context.fact;
	const factId = fact.id;
	const fm = node.fromMemory[factId];
	node.fromMemory[factId] = {};
	if (fm) {
		const factObject = fact.object;
		// lc, entry, cc, createdIsMatch,
		for (const i in fm) {
			const entry = fm[i];
			const lc = entry[0];
			const cc = entry[1];
			const createdIsMatch = cc.isMatch();
			if (lc.hashCode !== context.hashCode) {
				const newContext = __createMatch(node, lc, factObject);
				if (createdIsMatch) {
					retract(node, cc.clone());
				}
				if (newContext.isMatch()) {
					createdIsMatch ? modify(node, newContext.clone()) : assert(node, newContext.clone());
				}
			}
		}
	}
}

export function retract_left(node: IFromNode, context: Context) {
	const tuple = removeFromLeftMemory(node, context);
	if (tuple) {
		const ctx = tuple.data;
		const fromMatches = ctx.fromMatches;
		for (const i in fromMatches) {
			removeFromFromMemory(node, fromMatches[i]);
			retract(node, fromMatches[i].clone());
		}
	}
}